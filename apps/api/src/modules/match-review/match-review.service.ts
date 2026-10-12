import { Inject, Injectable, Logger } from '@nestjs/common';
import { MatchRoundStatus, Prisma, ServiceRequestStatus } from '@prisma/client';
import { logRel002Event } from '../../common/rel-002-events';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { isSuperAdmin } from '../auth/admin-permissions';
import { AuthUser } from '../auth/auth.types';
import { MAX_AUTO_MATCH_ROUNDS, openAdminRound } from '../match-rounds/match-round-transitions';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { enqueueManualReopenNotice, ServiceIssueOutbox } from '../notifications/service-issue-outbox.service';
import { MarketplacePublishSettingsService } from '../operations-settings/marketplace-publish-settings.service';
import { isPhoneVerificationRequired } from '../phone-verification/phone-verification.constants';
import { normalizeIncidentText } from '../service-incidents/service-incident-policy';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { OpenNextRoundDto } from './dto/open-next-round.dto';
import { matchReviewErrors } from './match-review.errors';

export const ROUND_OPENING_NOTE_MIN_LENGTH = 10;
export const ROUND_OPENING_NOTE_MAX_LENGTH = 2000;

/** The queue is small by nature (three failed matches each); a hard cap keeps one read bounded. */
const MATCH_REVIEW_QUEUE_LIMIT = 200;

export type OpenNextRoundResult = {
  openingId: string;
  requestId: string;
  requestStatus: ServiceRequestStatus;
  fromRound: { id: string; roundNumber: number };
  round: {
    id: string;
    roundNumber: number;
    status: MatchRoundStatus;
    publishedAt: Date | null;
    expiresAt: Date | null;
  };
  /** True when the canonical publish gate published the new round in the same transaction. */
  published: boolean;
  /** True when this call answered with an earlier, identical opening. */
  replayed: boolean;
};

/** Raised inside the transaction to leave it with a replay instead of a write. */
class ReplayFound {
  constructor(readonly openingId: string) {}
}

/**
 * REL-002 Faz 5 — staff recovery of a request whose three automatic rounds
 * failed (MATCH_REVIEW).
 *
 * One Serializable transaction opens Round N+1 (no hard cap) on the same
 * request: the failed rounds stay as they are, every exclusion stays, nobody
 * is refunded, no old offer, message or contact is carried over and no
 * incident is touched. The new round enters the canonical marketplace publish
 * gate — auto-publish on (and the telephone gate satisfied): published now,
 * through `publishRequestInTransaction`, with the round-aware fan-out; off:
 * SUBMITTED, in the moderation queue, `publishedAt` NULL until an approval.
 * **Nothing about credit is written.**
 *
 * Exactly once per failed round. The same `idempotencyKey` with the same
 * payload answers the earlier opening (200, `replayed`); the same key with a
 * different payload is 409 IDEMPOTENCY_KEY_REUSED; a different key on a
 * request already reopened from that round is 409
 * MATCH_REVIEW_ALREADY_REOPENED. The conditional request update (status
 * MATCH_REVIEW, current round the expected one) is the CAS; the round's
 * `(requestId, roundNumber)` unique and the opening's `fromRoundId` and
 * `idempotencyKey` uniques are the backstops for two openings racing past
 * the reads.
 */
@Injectable()
export class MatchReviewService {
  private readonly logger = new Logger(MatchReviewService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(ServiceRequestsService) private readonly serviceRequests: ServiceRequestsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
    @Inject(ServiceIssueOutbox) private readonly notices: ServiceIssueOutbox,
  ) {}

  async openNextRound(requestId: string, admin: AuthUser, dto: OpenNextRoundDto): Promise<OpenNextRoundResult> {
    // The permission is reserved for SUPER_ADMIN; this is the application half.
    if (!isSuperAdmin(admin)) {
      throw matchReviewErrors.superAdminRequired();
    }
    const note = normalizeIncidentText(dto.note);
    if (note === null || note.length < ROUND_OPENING_NOTE_MIN_LENGTH) {
      throw matchReviewErrors.noteRequired(ROUND_OPENING_NOTE_MIN_LENGTH);
    }
    if (note.length > ROUND_OPENING_NOTE_MAX_LENGTH) {
      throw matchReviewErrors.noteTooLong(ROUND_OPENING_NOTE_MAX_LENGTH);
    }
    const payload = { expectedCurrentRoundId: dto.expectedCurrentRoundId, note, idempotencyKey: dto.idempotencyKey };

    // Read once, outside the transaction: an operations switch that changes
    // rarely; an opening that raced a toggle lands on whichever side it read.
    const autoPublish = await this.publishSettings.isAutoPublishEnabled();

    let result: OpenNextRoundResult;
    try {
      result = await this.openOnce(requestId, admin, payload, autoPublish);
    } catch (error) {
      // Two openings raced past the reads and one collided on a unique the
      // other had just committed (the round's id or number, the from-round,
      // the idempotency key). Run once more against the committed state: the
      // same key is now a replay, another key is MATCH_REVIEW_ALREADY_REOPENED.
      if (!isUniqueViolation(error)) {
        throw error;
      }
      result = await this.openOnce(requestId, admin, payload, autoPublish);
    }

    if (!result.replayed) {
      this.notices.deliverSoon();
      if (result.published) {
        this.publishOutbox.deliverSoon();
      }
      logRel002Event(this.logger, 'manual_round_opened', {
        requestId: result.requestId,
        fromRound: result.fromRound.roundNumber,
        round: result.round.roundNumber,
        roundId: result.round.id,
        published: result.published,
        actorId: admin.id,
      });
    }
    return result;
  }

  private async openOnce(
    requestId: string,
    admin: AuthUser,
    payload: { expectedCurrentRoundId: string; note: string; idempotencyKey: string },
    autoPublish: boolean,
  ): Promise<OpenNextRoundResult> {
    try {
      return await runSerializable(
        this.prisma,
        (tx) => this.openInTransaction(tx, requestId, admin, payload, autoPublish),
        { label: 'matchReview.openNextRound' },
      );
    } catch (error) {
      if (error instanceof ReplayFound) {
        return this.resultFor(this.prisma, error.openingId, true);
      }
      throw error;
    }
  }

  private async openInTransaction(
    tx: Prisma.TransactionClient,
    requestId: string,
    admin: AuthUser,
    payload: { expectedCurrentRoundId: string; note: string; idempotencyKey: string },
    autoPublish: boolean,
  ): Promise<OpenNextRoundResult> {
    const now = new Date();

    // 1. The request and its current round.
    const request = await tx.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        currentRoundId: true,
        phoneVerifiedAt: true,
        currentRound: { select: { id: true, roundNumber: true, status: true } },
      },
    });
    if (!request) {
      throw matchReviewErrors.notFound();
    }

    // 2. Idempotency, before any state guard: a retried opening arrives after
    //    its own commit moved the request on, and must still get its answer.
    const earlier = await tx.serviceRequestRoundOpening.findUnique({
      where: { idempotencyKey: payload.idempotencyKey },
      select: { id: true, requestId: true, fromRoundId: true, note: true, openedByAdminId: true },
    });
    if (earlier) {
      const same =
        earlier.requestId === requestId &&
        earlier.fromRoundId === payload.expectedCurrentRoundId &&
        earlier.note === payload.note &&
        earlier.openedByAdminId === admin.id;
      if (!same) {
        throw matchReviewErrors.idempotencyKeyReused();
      }
      throw new ReplayFound(earlier.id);
    }

    // A failed round this request was already recovered from, whatever key did it.
    const recovered = await tx.serviceRequestRoundOpening.findUnique({
      where: { fromRoundId: payload.expectedCurrentRoundId },
      select: { requestId: true, openedRound: { select: { roundNumber: true } } },
    });
    if (recovered && recovered.requestId === requestId) {
      throw matchReviewErrors.alreadyReopened(recovered.openedRound.roundNumber);
    }

    // 3. The state the operator saw is the live one.
    if (request.status !== ServiceRequestStatus.MATCH_REVIEW) {
      throw matchReviewErrors.notInMatchReview();
    }
    if (request.currentRoundId !== payload.expectedCurrentRoundId) {
      throw matchReviewErrors.roundChanged();
    }
    const failed = request.currentRound;
    if (failed.status !== MatchRoundStatus.FAILED || failed.roundNumber < MAX_AUTO_MATCH_ROUNDS) {
      throw matchReviewErrors.inconsistent();
    }
    const live = await tx.serviceRequestMatchRound.count({
      where: { requestId, status: { in: [MatchRoundStatus.OPEN, MatchRoundStatus.MATCHED] } },
    });
    if (live > 0) {
      throw matchReviewErrors.inconsistent();
    }

    // ── Writes. Every conditional write must move exactly one row. ──────────
    const round = await openAdminRound(tx, { requestId, failedRoundNumber: failed.roundNumber, openedAt: now });

    // The CAS: still MATCH_REVIEW, still on the failed round the operator saw.
    // SUBMITTED is the publish gate's entry state; the projection is cleared
    // (it already is in MATCH_REVIEW — written again so no stale value
    // survives a hand-edited row).
    const moved = await tx.serviceRequest.updateMany({
      where: { id: requestId, status: ServiceRequestStatus.MATCH_REVIEW, currentRoundId: failed.id },
      data: {
        status: ServiceRequestStatus.SUBMITTED,
        currentRoundId: round.id,
        matchedOfferId: null,
        matchedAt: null,
        directShowcaseProviderId: null,
      },
    });
    if (moved.count !== 1) {
      throw matchReviewErrors.alreadyReopened(null);
    }

    const opening = await tx.serviceRequestRoundOpening.create({
      data: {
        requestId,
        fromRoundId: failed.id,
        openedRoundId: round.id,
        openedByAdminId: admin.id,
        note: payload.note,
        idempotencyKey: payload.idempotencyKey,
      },
      select: { id: true },
    });

    // The canonical marketplace publish gate — the same three conditions a
    // fresh marketplace request is born live under: the switch is on, the
    // request is not a vitrin lead (cleared above), and the number is either
    // not gated or already proven. Otherwise it waits at SUBMITTED for an
    // operator; the approval stamps the round's publishedAt then
    // (`roundPublicationFor`), and the fan-out goes with it.
    const publishNow = autoPublish && (!isPhoneVerificationRequired() || request.phoneVerifiedAt !== null);
    if (publishNow) {
      await this.serviceRequests.publishRequestInTransaction(tx, requestId, now);
    }

    await enqueueManualReopenNotice(tx, { roundId: round.id });

    return this.resultFor(tx, opening.id, false);
  }

  private async resultFor(
    client: Prisma.TransactionClient,
    openingId: string,
    replayed: boolean,
  ): Promise<OpenNextRoundResult> {
    const opening = await client.serviceRequestRoundOpening.findUniqueOrThrow({
      where: { id: openingId },
      select: {
        id: true,
        requestId: true,
        fromRound: { select: { id: true, roundNumber: true } },
        openedRound: {
          select: { id: true, roundNumber: true, status: true, publishedAt: true, expiresAt: true },
        },
        request: { select: { status: true } },
      },
    });
    return {
      openingId: opening.id,
      requestId: opening.requestId,
      requestStatus: opening.request.status,
      fromRound: opening.fromRound,
      round: opening.openedRound,
      published: opening.openedRound.publishedAt !== null,
      replayed,
    };
  }

  /**
   * The MATCH_REVIEW queue: every request waiting for staff, oldest failure
   * first, with what an operator needs to pick it up — the failed round, its
   * incident and the provider it named, how many rounds and exclusions the
   * request has. Customer contact is not part of a queue row.
   */
  async queue() {
    // Read in three index-bound steps rather than one ORDER BY over the
    // relation: Prisma joins the round table for a relation sort, and the
    // planner hash-joins (seq-scans) every round to sort a queue of a few
    // rows — linear in rounds ever opened. Here: the waiting requests and
    // their current round ids (status index), those rounds' failure times
    // (primary-key probes), then the page's details (primary-key probes).
    const waiting = await this.prisma.serviceRequest.findMany({
      where: { status: ServiceRequestStatus.MATCH_REVIEW },
      select: { id: true, currentRoundId: true },
    });
    const failures = await this.prisma.serviceRequestMatchRound.findMany({
      where: { id: { in: waiting.map((row) => row.currentRoundId) } },
      select: { requestId: true, failedAt: true },
    });
    // The failed current round's failure time is when the request entered
    // MATCH_REVIEW; the request id breaks ties deterministically.
    const pageIds = failures
      .sort(
        (a, b) =>
          (a.failedAt?.getTime() ?? 0) - (b.failedAt?.getTime() ?? 0) || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0),
      )
      .slice(0, MATCH_REVIEW_QUEUE_LIMIT)
      .map((row) => row.requestId);

    const rows = await this.prisma.serviceRequest.findMany({
      where: { id: { in: pageIds }, status: ServiceRequestStatus.MATCH_REVIEW },
      select: {
        id: true,
        requestNumber: true,
        city: true,
        district: true,
        submittedAt: true,
        category: { select: { id: true, name: true } },
        currentRound: {
          select: {
            id: true,
            roundNumber: true,
            failedAt: true,
            failureIncident: {
              select: {
                id: true,
                incidentNumber: true,
                status: true,
                reason: true,
                providerId: true,
                provider: { select: { businessName: true } },
              },
            },
          },
        },
      },
    });
    // Counted per page through each table's own requestId index (a relation
    // `_count` would hash-join the whole table).
    const [exclusions, openings] = await Promise.all([
      this.prisma.serviceRequestProviderExclusion.groupBy({
        by: ['requestId'],
        where: { requestId: { in: pageIds } },
        _count: { _all: true },
      }),
      this.prisma.serviceRequestRoundOpening.groupBy({
        by: ['requestId'],
        where: { requestId: { in: pageIds } },
        _count: { _all: true },
      }),
    ]);
    const exclusionCount = new Map(exclusions.map((row) => [row.requestId, row._count._all]));
    const openingCount = new Map(openings.map((row) => [row.requestId, row._count._all]));
    const position = new Map(pageIds.map((id, index) => [id, index]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

    return {
      total: waiting.length,
      items: rows.map((row) => ({
        ...row,
        exclusionCount: exclusionCount.get(row.id) ?? 0,
        manualOpeningCount: openingCount.get(row.id) ?? 0,
      })),
    };
  }
}

/**
 * A P2002. The only rows this transaction inserts under a unique are the new
 * round (its id, `(requestId, roundNumber)`, the one-active-round partial
 * unique) and the opening (`fromRoundId`, `openedRoundId`, `idempotencyKey`);
 * any of them colliding means a concurrent opening of the same failed round
 * committed first.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
