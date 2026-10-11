import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MatchRoundSource,
  MatchRoundStatus,
  NumberedEntityType,
  OfferStatus,
  Prisma,
  ServiceIssueReason,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  MAX_AUTO_MATCH_ROUNDS,
  openNextRound,
  transitionRoundToFailed,
} from '../match-rounds/match-round-transitions';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { enqueueServiceIssueNotices, ServiceIssueOutbox } from '../notifications/service-issue-outbox.service';
import { NumberingService } from '../numbering/numbering.service';
import { MarketplacePublishSettingsService } from '../operations-settings/marketplace-publish-settings.service';
import { ServiceIssueSettingsService } from '../operations-settings/service-issue-settings.service';
import { isPhoneVerificationRequired } from '../phone-verification/phone-verification.constants';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { ReportServiceIssueDto } from './dto/report-service-issue.dto';
import {
  eligibilityBasisFor,
  evaluateServiceIssueEligibility,
  normalizeServiceIssueNote,
  NOTE_REQUIRED_REASONS,
  SERVICE_ISSUE_NOTE_MAX_LENGTH,
  SERVICE_ISSUE_NOTE_MIN_LENGTH,
} from './service-issue-eligibility';
import { serviceIssueErrors, serviceIssueNotFound } from './service-issue.errors';

/** Successful reports one customer may make in the window (abuse guard, REL-002 §23). */
export const SERVICE_ISSUE_MAX_REPORTS_PER_WINDOW = 5;
export const SERVICE_ISSUE_REPORT_WINDOW_MS = 10 * 60 * 1000;

export type ServiceIssueOutcome = 'REOPENED' | 'ADMIN_REVIEW';

export type ServiceIssueResult = {
  incidentId: string;
  incidentNumber: string;
  failedRoundNumber: number;
  outcome: ServiceIssueOutcome;
  /** True when this call answered with an earlier, identical report. */
  replayed: boolean;
  requestStatus: ServiceRequestStatus;
  currentRound: {
    id: string;
    roundNumber: number;
    status: MatchRoundStatus;
    publishedAt: Date | null;
    expiresAt: Date | null;
  };
};

/** Raised inside the transaction to leave it with a replay instead of a write. */
class ReplayFound {
  constructor(readonly incidentId: string) {}
}

/**
 * REL-002 Faz 3 — a customer closes a match that did not deliver.
 *
 * One Serializable transaction does all of it or none of it: the incident,
 * the round's MATCHED → FAILED, the provider's exclusion from the request,
 * the request projection cleared, and either Round N+1 (N < 3) or
 * MATCH_REVIEW (N = 3), with the notices the outcome owes. **Nothing about
 * credit is written**: the failed provider's accepted offer stays ACCEPTED and
 * paid — no refund, no recharge reversal, no promotion restore.
 *
 * Exactly once per round. The same `idempotencyKey` with the same payload
 * answers the earlier report (200, `replayed`); the same key with a different
 * payload is 409 IDEMPOTENCY_KEY_REUSED; a different key on a round that
 * already failed is 409 ROUND_ALREADY_FAILED. `ProviderServiceIncident`'s
 * uniques on `idempotencyKey` and `roundId` are the backstop for two reports
 * racing past the reads.
 */
@Injectable()
export class ServiceIssueService {
  private readonly logger = new Logger(ServiceIssueService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(ServiceIssueSettingsService) private readonly settings: ServiceIssueSettingsService,
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(ServiceRequestsService) private readonly serviceRequests: ServiceRequestsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
    @Inject(ServiceIssueOutbox) private readonly notices: ServiceIssueOutbox,
  ) {}

  async report(requestId: string, user: AuthUser, dto: ReportServiceIssueDto): Promise<ServiceIssueResult> {
    // Off: the route does not exist, for everybody.
    if (!(await this.settings.isEnabled())) {
      throw serviceIssueNotFound();
    }
    if (user.role !== UserRole.CUSTOMER) {
      throw serviceIssueNotFound();
    }

    const note = normalizeServiceIssueNote(dto.note);
    if (note !== null && note.length > SERVICE_ISSUE_NOTE_MAX_LENGTH) {
      throw serviceIssueErrors.noteTooLong(SERVICE_ISSUE_NOTE_MAX_LENGTH);
    }
    const payload = { roundId: dto.roundId, reason: dto.reason, note, idempotencyKey: dto.idempotencyKey };

    // Read once, outside the transaction: an operations switch that changes
    // rarely; a reopen that raced a toggle lands on whichever side it read.
    const autoPublish = await this.publishSettings.isAutoPublishEnabled();

    let result: ServiceIssueResult;
    try {
      result = await this.reportOnce(requestId, user, payload, autoPublish);
    } catch (error) {
      // Two reports raced past the reads. The idempotency key's unique means
      // this very report committed elsewhere — answer it as a replay; the
      // round's unique means another report closed the round first.
      const target = uniqueViolationTarget(error);
      if (target === 'idempotencyKey') {
        result = await this.reportOnce(requestId, user, payload, autoPublish);
      } else if (target === 'roundId' || target === 'offerId') {
        throw serviceIssueErrors.roundAlreadyFailed();
      } else {
        throw error;
      }
    }

    if (!result.replayed) {
      this.notices.deliverSoon();
      if (result.outcome === 'REOPENED') {
        this.publishOutbox.deliverSoon();
      }
    }
    return result;
  }

  private async reportOnce(
    requestId: string,
    user: AuthUser,
    payload: { roundId: string; reason: ServiceIssueReason; note: string | null; idempotencyKey: string },
    autoPublish: boolean,
  ): Promise<ServiceIssueResult> {
    try {
      return await runSerializable(
        this.prisma,
        (tx) => this.reportInTransaction(tx, requestId, user, payload, autoPublish),
        { label: 'serviceRequests.reportServiceIssue' },
      );
    } catch (error) {
      if (error instanceof ReplayFound) {
        return this.replayResult(error.incidentId);
      }
      throw error;
    }
  }

  private async reportInTransaction(
    tx: Prisma.TransactionClient,
    requestId: string,
    user: AuthUser,
    payload: { roundId: string; reason: ServiceIssueReason; note: string | null; idempotencyKey: string },
    autoPublish: boolean,
  ): Promise<ServiceIssueResult> {
    const now = new Date();

    // 1. The request, owned by this customer. Anybody else's request and a
    //    request that does not exist are the same 404.
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        customerId: true,
        status: true,
        matchedOfferId: true,
        currentRoundId: true,
        phoneVerifiedAt: true,
        currentRound: {
          select: {
            id: true,
            roundNumber: true,
            status: true,
            source: true,
            matchedOfferId: true,
            matchedProviderId: true,
          },
        },
      },
    });
    if (!request || !request.customerId || request.customerId !== user.id) {
      throw serviceIssueNotFound();
    }

    // 2. Idempotency, before any state guard: a retried report arrives after
    //    its own commit moved the request on, and must still get its answer.
    const earlier = await tx.providerServiceIncident.findUnique({
      where: { idempotencyKey: payload.idempotencyKey },
      select: { id: true, requestId: true, roundId: true, customerUserId: true, reason: true, customerNote: true },
    });
    if (earlier) {
      const same =
        earlier.customerUserId === user.id &&
        earlier.requestId === requestId &&
        earlier.roundId === payload.roundId &&
        earlier.reason === payload.reason &&
        (earlier.customerNote ?? null) === payload.note;
      if (!same) {
        throw serviceIssueErrors.idempotencyKeyReused();
      }
      throw new ReplayFound(earlier.id);
    }

    // A round that already failed, whatever key reported it.
    const roundIncident = await tx.providerServiceIncident.findUnique({
      where: { roundId: payload.roundId },
      select: { id: true, requestId: true },
    });
    if (roundIncident && roundIncident.requestId === requestId) {
      throw serviceIssueErrors.roundAlreadyFailed();
    }

    // 3. The match the customer saw is the live one.
    if (request.status !== ServiceRequestStatus.MATCHED) {
      throw serviceIssueErrors.requestNotMatched();
    }
    if (request.currentRoundId !== payload.roundId) {
      throw serviceIssueErrors.roundChanged();
    }
    const round = request.currentRound;
    if (
      round.status !== MatchRoundStatus.MATCHED ||
      !request.matchedOfferId ||
      round.matchedOfferId !== request.matchedOfferId ||
      !round.matchedProviderId
    ) {
      throw serviceIssueErrors.matchInconsistent();
    }

    const offer = await tx.offer.findUnique({
      where: { id: request.matchedOfferId },
      select: {
        id: true,
        status: true,
        providerId: true,
        matchRoundId: true,
        estimatedStartDate: true,
        estimatedCompletionDate: true,
        provider: { select: { id: true } },
      },
    });
    if (
      !offer ||
      offer.status !== OfferStatus.ACCEPTED ||
      offer.matchRoundId !== round.id ||
      offer.providerId !== round.matchedProviderId
    ) {
      throw serviceIssueErrors.matchInconsistent();
    }

    // 4. Eligibility from the offer's own promised days, at the server's now.
    const eligibility = evaluateServiceIssueEligibility(
      { start: offer.estimatedStartDate, end: offer.estimatedCompletionDate },
      now,
    );
    if (eligibility.supportOnly) {
      throw serviceIssueErrors.requiresSupport();
    }
    const availability = eligibility.reasons.find((entry) => entry.reason === payload.reason);
    if (!availability?.available) {
      throw serviceIssueErrors.reasonNotYetAvailable(availability?.opensOn ?? null);
    }

    // 5. The note rule.
    if (NOTE_REQUIRED_REASONS.has(payload.reason) && (payload.note?.length ?? 0) < SERVICE_ISSUE_NOTE_MIN_LENGTH) {
      throw serviceIssueErrors.noteRequired(SERVICE_ISSUE_NOTE_MIN_LENGTH);
    }

    // 6. Abuse guard: successful reports by this customer in the window.
    const recent = await tx.providerServiceIncident.count({
      where: { customerUserId: user.id, reportedAt: { gte: new Date(now.getTime() - SERVICE_ISSUE_REPORT_WINDOW_MS) } },
    });
    if (recent >= SERVICE_ISSUE_MAX_REPORTS_PER_WINDOW) {
      throw serviceIssueErrors.rateLimited();
    }

    // ── Writes. Every conditional write must move exactly one row. ──────────
    const incidentNumber = await this.numbering.generateDisplayNumber(tx, NumberedEntityType.SERVICE_INCIDENT, now);
    const incident = await tx.providerServiceIncident.create({
      data: {
        incidentNumber,
        providerId: offer.providerId,
        requestId,
        roundId: round.id,
        offerId: offer.id,
        customerUserId: user.id,
        reason: payload.reason,
        customerNote: payload.note,
        idempotencyKey: payload.idempotencyKey,
        reportedAt: now,
        promisedStartDate: offer.estimatedStartDate,
        promisedEndDate: offer.estimatedCompletionDate,
        eligibilityBasis: eligibilityBasisFor(payload.reason),
      },
      select: { id: true, incidentNumber: true },
    });

    await transitionRoundToFailed(tx, {
      roundId: round.id,
      offerId: offer.id,
      incidentId: incident.id,
      failedAt: now,
    });

    await tx.serviceRequestProviderExclusion.create({
      data: {
        requestId,
        providerId: offer.providerId,
        sourceRoundId: round.id,
        incidentId: incident.id,
        reason: payload.reason,
      },
    });

    const reopens = round.roundNumber < MAX_AUTO_MATCH_ROUNDS;
    let reopenedRoundId: string | null = null;

    if (reopens) {
      // A direct vitrin lead never passed moderation (its owner's offer made
      // it APPROVED), so its marketplace round goes through the canonical
      // publish gate; a marketplace request was published once already.
      const neverModerated = round.source === MatchRoundSource.DIRECT_SHOWCASE;
      const publishNow =
        !neverModerated ||
        (autoPublish && (!isPhoneVerificationRequired() || request.phoneVerifiedAt !== null));

      const next = await openNextRound(tx, {
        requestId,
        failedRoundNumber: round.roundNumber,
        openedAt: now,
        publishedAt: !neverModerated ? now : null,
      });
      reopenedRoundId = next.id;

      const moved = await tx.serviceRequest.updateMany({
        where: {
          id: requestId,
          status: ServiceRequestStatus.MATCHED,
          matchedOfferId: offer.id,
          currentRoundId: round.id,
        },
        data: {
          status: neverModerated ? ServiceRequestStatus.SUBMITTED : ServiceRequestStatus.APPROVED,
          matchedOfferId: null,
          matchedAt: null,
          directShowcaseProviderId: null,
          currentRoundId: next.id,
        },
      });
      if (moved.count !== 1) {
        throw serviceIssueErrors.roundChanged();
      }

      if (!neverModerated) {
        // The new round's fan-out, round-aware keys (`…:r<N>`); the excluded
        // provider is not in the audience.
        await this.publishOutbox.enqueue(tx, requestId, now);
      } else if (publishNow) {
        // Auto-publish on: the same gate a fresh marketplace request passes.
        await this.serviceRequests.publishRequestInTransaction(tx, requestId, now);
      }
      // Auto-publish off: SUBMITTED, in the moderation queue; approval stamps
      // the round's publishedAt then (`roundPublicationFor`).
    } else {
      const moved = await tx.serviceRequest.updateMany({
        where: {
          id: requestId,
          status: ServiceRequestStatus.MATCHED,
          matchedOfferId: offer.id,
          currentRoundId: round.id,
        },
        data: {
          status: ServiceRequestStatus.MATCH_REVIEW,
          matchedOfferId: null,
          matchedAt: null,
          directShowcaseProviderId: null,
        },
      });
      if (moved.count !== 1) {
        throw serviceIssueErrors.roundChanged();
      }
    }

    await enqueueServiceIssueNotices(tx, { incidentId: incident.id, reopenedRoundId });

    this.logger.log(
      `service issue ${incident.incidentNumber} on request ${requestId}: round ${round.roundNumber} failed, ` +
        (reopens ? `round ${round.roundNumber + 1} opened` : 'request in MATCH_REVIEW'),
    );

    return this.resultFor(tx, incident.id, false);
  }

  private replayResult(incidentId: string): Promise<ServiceIssueResult> {
    return this.resultFor(this.prisma, incidentId, true);
  }

  private async resultFor(
    client: Prisma.TransactionClient,
    incidentId: string,
    replayed: boolean,
  ): Promise<ServiceIssueResult> {
    const incident = await client.providerServiceIncident.findUniqueOrThrow({
      where: { id: incidentId },
      select: {
        id: true,
        incidentNumber: true,
        round: { select: { roundNumber: true } },
        request: {
          select: {
            status: true,
            currentRound: {
              select: { id: true, roundNumber: true, status: true, publishedAt: true, expiresAt: true },
            },
          },
        },
      },
    });
    const failedRoundNumber = incident.round.roundNumber;
    return {
      incidentId: incident.id,
      incidentNumber: incident.incidentNumber,
      failedRoundNumber,
      outcome: failedRoundNumber < MAX_AUTO_MATCH_ROUNDS ? 'REOPENED' : 'ADMIN_REVIEW',
      replayed,
      requestStatus: incident.request.status,
      currentRound: incident.request.currentRound,
    };
  }
}

/** Which unique a P2002 hit on the incident table, if it was one. */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = (error.meta?.target ?? []) as string[] | string;
  const fields = Array.isArray(target) ? target : [target];
  for (const field of ['idempotencyKey', 'roundId', 'offerId']) {
    if (fields.some((entry) => entry === field || entry.includes(`_${field}_`))) {
      return field;
    }
  }
  return null;
}
