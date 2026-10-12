import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ProviderIncidentAdjudicationKind,
  ProviderIncidentDecision,
  ProviderIncidentStatus,
} from '@prisma/client';
import { logRel002Event } from '../../common/rel-002-events';
import { CONCURRENT_MODIFICATION_CODE, runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { isSuperAdmin } from '../auth/admin-permissions';
import type { AuthUser } from '../auth/auth.types';
import {
  enqueueIncidentDecisionNotice,
  enqueueReliabilityReviewNotice,
  ServiceIssueOutbox,
} from '../notifications/service-issue-outbox.service';
import { SERVICE_ISSUE_REASON_LABELS } from '../service-issues/service-issue-eligibility';
import type { ListServiceIncidentsDto } from './dto/incident-dtos';
import {
  confirmedCountsByProvider,
  customerReportSummary,
  ensureReliabilityReview,
  providerReliabilitySummary,
  unresolvedReview,
} from './incident-reliability';
import {
  incidentNotFound,
  incidentTriggerCode,
  isAdjudicationChainCollision,
  SERVICE_INCIDENT_CODES,
  serviceIncidentErrors,
} from './service-incident.errors';
import {
  normalizeIncidentText,
  PROVIDER_RESPONSE_SLA_MS,
  RATIONALE_MAX_LENGTH,
  RATIONALE_MIN_LENGTH,
  RELIABILITY_WARNING_AT,
  reliabilityLevel,
  responseDueAt,
  type ReliabilityLevel,
} from './service-incident-policy';

const DEFAULT_PAGE_SIZE = 25;
const OPEN_STATUSES: ProviderIncidentStatus[] = [ProviderIncidentStatus.REPORTED, ProviderIncidentStatus.PROVIDER_RESPONDED];
const DECIDED_STATUSES: ProviderIncidentStatus[] = [ProviderIncidentStatus.CONFIRMED, ProviderIncidentStatus.DISMISSED];

export type AdjudicationResult = {
  incidentId: string;
  adjudicationId: string;
  kind: ProviderIncidentAdjudicationKind;
  decision: ProviderIncidentDecision;
  sequence: number;
  /** The review this decision opened (third effective confirmation), if any. */
  openedReviewId: string | null;
  providerReliability: { confirmed: number; level: ReliabilityLevel };
};

/**
 * REL-002 Faz 4 — staff decisions on provider service incidents.
 *
 * A decision is an **appended** adjudication; nothing is ever edited. The
 * initial one needs SERVICE_INCIDENTS_ADJUDICATE; a correction needs a
 * SUPER_ADMIN and the head the SUPER_ADMIN saw (compare-and-swap on
 * `effectiveAdjudicationId`). Both write, in one Serializable transaction:
 * the adjudication, the head swap, the status/reviewed* projection, the
 * provider's notice, and — when the effective confirmed count reaches three —
 * an idempotent reliability review.
 *
 * What a decision never does: change the failed round, remove the exclusion,
 * refund or move credit, reopen the old match, touch the request's current
 * round, or suspend anybody.
 */
@Injectable()
export class AdminServiceIncidentsService {
  private readonly logger = new Logger(AdminServiceIncidentsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ServiceIssueOutbox) private readonly notices: ServiceIssueOutbox,
  ) {}

  // ── queue ────────────────────────────────────────────────────────────────

  async list(query: ListServiceIncidentsDto) {
    const now = new Date();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const state = query.status ?? 'open';
    const where: Prisma.ProviderServiceIncidentWhereInput = {};
    const and: Prisma.ProviderServiceIncidentWhereInput[] = [];

    if (state === 'open') where.status = { in: OPEN_STATUSES };
    else if (state === 'decided') where.status = { in: DECIDED_STATUSES };
    else if (state !== 'all') where.status = state;

    if (query.reason) where.reason = query.reason;
    if (query.providerId) where.providerId = query.providerId;
    if (query.from || query.to) {
      where.reportedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lt: new Date(query.to) } : {}),
      };
    }
    if (query.response === 'responded') and.push({ providerRespondedAt: { not: null } });
    if (query.response === 'not_responded') and.push({ providerRespondedAt: null });
    const overdueCutoff = new Date(now.getTime() - PROVIDER_RESPONSE_SLA_MS);
    if (query.overdue === true) {
      and.push({ providerRespondedAt: null, effectiveAdjudicationId: null, reportedAt: { lt: overdueCutoff } });
    } else if (query.overdue === false) {
      and.push({
        OR: [{ providerRespondedAt: { not: null } }, { effectiveAdjudicationId: { not: null } }, { reportedAt: { gte: overdueCutoff } }],
      });
    }
    if (query.risk) {
      // Providers at WARNING or above are few (a partial index of confirmed
      // incidents); NORMAL is "every other provider".
      const counts = await confirmedCountsByProvider(this.prisma, now, { atLeast: RELIABILITY_WARNING_AT });
      const at = (level: ReliabilityLevel) =>
        [...counts.entries()].filter(([, confirmed]) => reliabilityLevel(confirmed) === level).map(([id]) => id);
      if (query.risk === 'NORMAL') and.push({ providerId: { notIn: [...counts.keys()] } });
      else and.push({ providerId: { in: at(query.risk) } });
    }
    if (and.length > 0) where.AND = and;

    // Oldest unresolved first: the open queue ascends; a decided list is history, newest first.
    const orderBy: Prisma.ProviderServiceIncidentOrderByWithRelationInput[] =
      state === 'open' || state === ProviderIncidentStatus.REPORTED || state === ProviderIncidentStatus.PROVIDER_RESPONDED
        ? [{ reportedAt: 'asc' }, { id: 'asc' }]
        : [{ reportedAt: 'desc' }, { id: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.providerServiceIncident.count({ where }),
      this.prisma.providerServiceIncident.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          incidentNumber: true,
          status: true,
          reason: true,
          reportedAt: true,
          providerRespondedAt: true,
          effectiveAdjudication: { select: { id: true, decision: true, kind: true, createdAt: true } },
          provider: { select: { id: true, businessName: true } },
          request: { select: { id: true, requestNumber: true, category: { select: { name: true } } } },
          round: { select: { roundNumber: true } },
        },
      }),
    ]);

    const providerIds = [...new Set(rows.map((row) => row.provider.id))];
    const counts = await confirmedCountsByProvider(this.prisma, now, { providerIds });

    return {
      items: rows.map((row) => {
        const due = responseDueAt(row.reportedAt);
        const confirmed = counts.get(row.provider.id) ?? 0;
        return {
          id: row.id,
          incidentNumber: row.incidentNumber,
          status: row.status,
          reason: row.reason,
          reasonLabel: SERVICE_ISSUE_REASON_LABELS[row.reason],
          reportedAt: row.reportedAt,
          responseDueAt: due,
          respondedAt: row.providerRespondedAt,
          responseOverdue: row.effectiveAdjudication === null && row.providerRespondedAt === null && now > due,
          lateResponse: row.providerRespondedAt !== null && row.providerRespondedAt > due,
          roundNumber: row.round.roundNumber,
          provider: { id: row.provider.id, businessName: row.provider.businessName, confirmed90d: confirmed, riskLevel: reliabilityLevel(confirmed) },
          request: { id: row.request.id, requestNumber: row.request.requestNumber, categoryName: row.request.category.name },
          decision: row.effectiveAdjudication
            ? {
                adjudicationId: row.effectiveAdjudication.id,
                decision: row.effectiveAdjudication.decision,
                corrected: row.effectiveAdjudication.kind === ProviderIncidentAdjudicationKind.CORRECTION,
                decidedAt: row.effectiveAdjudication.createdAt,
              }
            : null,
        };
      }),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
    };
  }

  // ── detail ───────────────────────────────────────────────────────────────

  async get(incidentId: string) {
    const now = new Date();
    const incident = await this.prisma.providerServiceIncident.findUnique({
      where: { id: incidentId },
      select: {
        id: true,
        incidentNumber: true,
        status: true,
        reason: true,
        customerNote: true,
        reportedAt: true,
        promisedStartDate: true,
        promisedEndDate: true,
        eligibilityBasis: true,
        providerResponse: true,
        providerRespondedAt: true,
        effectiveAdjudicationId: true,
        customerUserId: true,
        offer: { select: { id: true, status: true, priceAmount: true, estimatedStartDate: true, estimatedCompletionDate: true } },
        round: { select: { id: true, roundNumber: true, status: true, source: true, matchedAt: true, failedAt: true } },
        provider: { select: { id: true, businessName: true, status: true } },
        customer: { select: { id: true, name: true } },
        exclusions: { select: { id: true, createdAt: true } },
        request: {
          select: {
            id: true,
            requestNumber: true,
            status: true,
            city: true,
            district: true,
            category: { select: { name: true } },
            currentRound: { select: { roundNumber: true, status: true } },
          },
        },
        adjudications: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            kind: true,
            decision: true,
            rationale: true,
            createdAt: true,
            supersedesAdjudicationId: true,
            decidedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!incident) {
      throw incidentNotFound();
    }

    const [providerReliability, review, customerReports] = await Promise.all([
      providerReliabilitySummary(this.prisma, incident.provider.id, now),
      unresolvedReview(this.prisma, incident.provider.id),
      customerReportSummary(this.prisma, incident.customerUserId, now),
    ]);

    const due = responseDueAt(incident.reportedAt);
    const byId = new Map(incident.adjudications.map((a) => [a.id, a]));
    const head = incident.effectiveAdjudicationId ? byId.get(incident.effectiveAdjudicationId) ?? null : null;

    return {
      id: incident.id,
      incidentNumber: incident.incidentNumber,
      status: incident.status,
      reason: incident.reason,
      reasonLabel: SERVICE_ISSUE_REASON_LABELS[incident.reason],
      customerNote: incident.customerNote,
      reportedAt: incident.reportedAt,
      eligibilityBasis: incident.eligibilityBasis,
      schedule: { promisedStartDate: incident.promisedStartDate, promisedEndDate: incident.promisedEndDate },
      response: {
        text: incident.providerResponse,
        respondedAt: incident.providerRespondedAt,
        dueAt: due,
        overdue: head === null && incident.providerRespondedAt === null && now > due,
        late: incident.providerRespondedAt !== null && incident.providerRespondedAt > due,
        windowOpen: now <= due,
      },
      request: {
        id: incident.request.id,
        requestNumber: incident.request.requestNumber,
        status: incident.request.status,
        categoryName: incident.request.category.name,
        city: incident.request.city,
        district: incident.request.district,
        currentRound: incident.request.currentRound,
      },
      round: incident.round,
      offer: incident.offer,
      provider: incident.provider,
      customer: incident.customer,
      exclusion: { exists: incident.exclusions.length > 0, createdAt: incident.exclusions[0]?.createdAt ?? null },
      /** A decision never refunds: stated, so nobody has to infer it. */
      creditInvariant: 'NO_AUTOMATIC_REFUND' as const,
      effective: head
        ? { adjudicationId: head.id, decision: head.decision, kind: head.kind, sequence: head.sequence, decidedAt: head.createdAt }
        : { adjudicationId: null, decision: 'PENDING' as const, kind: null, sequence: null, decidedAt: null },
      adjudications: incident.adjudications.map((a) => ({
        id: a.id,
        sequence: a.sequence,
        kind: a.kind,
        decision: a.decision,
        previousDecision: a.supersedesAdjudicationId ? byId.get(a.supersedesAdjudicationId)?.decision ?? null : null,
        supersedesAdjudicationId: a.supersedesAdjudicationId,
        rationale: a.rationale,
        decidedAt: a.createdAt,
        decidedBy: a.decidedBy,
        effective: a.id === incident.effectiveAdjudicationId,
      })),
      providerReliability: { ...providerReliability, openReview: review },
      customerReports,
    };
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async adjudicate(
    incidentId: string,
    admin: AuthUser,
    input: { decision: ProviderIncidentDecision; rationale: string },
  ): Promise<AdjudicationResult> {
    const rationale = readRationale(input.rationale);
    const result = await this.decide(incidentId, ProviderIncidentAdjudicationKind.INITIAL, async (tx, incident, now) => {
      if (incident.effectiveAdjudicationId !== null) {
        throw serviceIncidentErrors.alreadyAdjudicated();
      }
      return {
        kind: ProviderIncidentAdjudicationKind.INITIAL,
        sequence: 1,
        supersedes: null,
        decision: input.decision,
        rationale,
        actorId: admin.id,
        now,
      };
    });
    this.logger.log(
      `incident ${incidentId}: ${result.decision} by ${admin.id} (adjudication ${result.adjudicationId})` +
        (result.openedReviewId ? `, reliability review ${result.openedReviewId} opened` : ''),
    );
    this.logEvents(result, admin.id);
    return result;
  }

  async correct(
    incidentId: string,
    admin: AuthUser,
    input: { decision: ProviderIncidentDecision; rationale: string; expectedEffectiveAdjudicationId: string },
  ): Promise<AdjudicationResult & { previousAdjudicationId: string; previousDecision: ProviderIncidentDecision }> {
    // The permission is reserved for SUPER_ADMIN; this is the application half.
    if (!isSuperAdmin(admin)) {
      throw serviceIncidentErrors.superAdminRequired();
    }
    const rationale = readRationale(input.rationale);
    let previous: { id: string; decision: ProviderIncidentDecision } | null = null;
    const result = await this.decide(incidentId, ProviderIncidentAdjudicationKind.CORRECTION, async (tx, incident, now) => {
      if (incident.effectiveAdjudicationId === null) {
        throw serviceIncidentErrors.notAdjudicated();
      }
      if (incident.effectiveAdjudicationId !== input.expectedEffectiveAdjudicationId) {
        throw serviceIncidentErrors.adjudicationChanged(incident.effectiveAdjudicationId);
      }
      const head = await tx.providerIncidentAdjudication.findUniqueOrThrow({
        where: { id: incident.effectiveAdjudicationId },
        select: { id: true, sequence: true, decision: true },
      });
      if (head.decision === input.decision) {
        throw serviceIncidentErrors.correctionSameDecision();
      }
      previous = { id: head.id, decision: head.decision };
      return {
        kind: ProviderIncidentAdjudicationKind.CORRECTION,
        sequence: head.sequence + 1,
        supersedes: head.id,
        decision: input.decision,
        rationale,
        actorId: admin.id,
        now,
      };
    });
    const before = previous as { id: string; decision: ProviderIncidentDecision } | null;
    // The correction's audit line: previous effective, new, both ids, who.
    this.logger.log(
      `incident ${incidentId}: CORRECTION by SUPER_ADMIN ${admin.id}: ${before?.decision} (${before?.id}) → ` +
        `${result.decision} (${result.adjudicationId})`,
    );
    this.logEvents(result, admin.id);
    return { ...result, previousAdjudicationId: before!.id, previousDecision: before!.decision };
  }

  /** REL-002 Faz 5 observability: one event per decision, and one per review it opened. */
  private logEvents(result: AdjudicationResult, actorId: string) {
    logRel002Event(
      this.logger,
      result.kind === ProviderIncidentAdjudicationKind.CORRECTION ? 'incident_correction_applied' : 'incident_adjudicated',
      {
        incidentId: result.incidentId,
        adjudicationId: result.adjudicationId,
        decision: result.decision,
        sequence: result.sequence,
        actorId,
      },
    );
    if (result.openedReviewId) {
      logRel002Event(this.logger, 'reliability_review_opened', {
        reviewId: result.openedReviewId,
        incidentId: result.incidentId,
        confirmed: result.providerReliability.confirmed,
      });
    }
  }

  /**
   * The one write path both decisions share. `plan` reads the guards and says
   * what to append; everything after it is identical: append, compare-and-swap
   * the head, project the status, notify, and open a review at the threshold.
   */
  private async decide(
    incidentId: string,
    kind: ProviderIncidentAdjudicationKind,
    plan: (
      tx: Prisma.TransactionClient,
      incident: { id: string; providerId: string; effectiveAdjudicationId: string | null },
      now: Date,
    ) => Promise<{
      kind: ProviderIncidentAdjudicationKind;
      sequence: number;
      supersedes: string | null;
      decision: ProviderIncidentDecision;
      rationale: string;
      actorId: string;
      now: Date;
    }>,
  ): Promise<AdjudicationResult> {
    let result: Omit<AdjudicationResult, 'providerReliability'> & { providerId: string };
    try {
      result = await runSerializable(
        this.prisma,
        async (tx) => {
          const now = new Date();
          const incident = await tx.providerServiceIncident.findUnique({
            where: { id: incidentId },
            select: { id: true, providerId: true, effectiveAdjudicationId: true },
          });
          if (!incident) {
            throw incidentNotFound();
          }
          const step = await plan(tx, incident, now);

          const adjudication = await tx.providerIncidentAdjudication.create({
            data: {
              incidentId,
              sequence: step.sequence,
              kind: step.kind,
              decision: step.decision,
              rationale: step.rationale,
              decidedByAdminId: step.actorId,
              supersedesAdjudicationId: step.supersedes,
              createdAt: now,
            },
            select: { id: true },
          });

          // Compare-and-swap: only from the head the plan read.
          const swapped = await tx.providerServiceIncident.updateMany({
            where: { id: incidentId, effectiveAdjudicationId: incident.effectiveAdjudicationId },
            data: {
              effectiveAdjudicationId: adjudication.id,
              status: step.decision,
              reviewedById: step.actorId,
              reviewedAt: now,
              reviewNote: step.rationale,
            },
          });
          if (swapped.count !== 1) {
            throw serviceIncidentErrors.adjudicationChanged(null);
          }

          await enqueueIncidentDecisionNotice(tx, { adjudicationId: adjudication.id });

          let openedReviewId: string | null = null;
          if (step.decision === ProviderIncidentDecision.CONFIRMED) {
            openedReviewId = await ensureReliabilityReview(tx, {
              providerId: incident.providerId,
              triggerIncidentId: incidentId,
              now,
            });
            if (openedReviewId) {
              await enqueueReliabilityReviewNotice(tx, { reviewId: openedReviewId, providerId: incident.providerId });
            }
          }

          return {
            incidentId,
            providerId: incident.providerId,
            adjudicationId: adjudication.id,
            kind: step.kind,
            decision: step.decision,
            sequence: step.sequence,
            openedReviewId,
          };
        },
        { label: 'serviceIncidents.adjudicate' },
      );
    } catch (error) {
      throw await this.translateDecisionError(error, incidentId, kind);
    }
    this.notices.deliverSoon();
    // Read after the commit: the level this decision left the provider at.
    const { providerId, ...decided } = result;
    const reliability = await providerReliabilitySummary(this.prisma, providerId, new Date());
    return { ...decided, providerReliability: { confirmed: reliability.confirmed, level: reliability.level } };
  }

  /** A race the reads did not see, answered with the code the reads would have given. */
  private async translateDecisionError(
    error: unknown,
    incidentId: string,
    kind: ProviderIncidentAdjudicationKind,
  ): Promise<unknown> {
    const code = incidentTriggerCode(error);
    const exhausted =
      typeof error === 'object' &&
      error !== null &&
      'getResponse' in error &&
      JSON.stringify((error as { getResponse: () => unknown }).getResponse()).includes(CONCURRENT_MODIFICATION_CODE);
    if (code === null && !isAdjudicationChainCollision(error) && !exhausted) {
      return error;
    }
    const current = await this.prisma.providerServiceIncident.findUnique({
      where: { id: incidentId },
      select: { effectiveAdjudicationId: true },
    });
    // An initial decision that lost a race lost it to another initial decision.
    if (code === SERVICE_INCIDENT_CODES.ALREADY_ADJUDICATED || kind === ProviderIncidentAdjudicationKind.INITIAL) {
      return serviceIncidentErrors.alreadyAdjudicated();
    }
    return serviceIncidentErrors.adjudicationChanged(current?.effectiveAdjudicationId ?? null);
  }
}

function readRationale(value: string): string {
  const rationale = normalizeIncidentText(value);
  if (rationale === null || rationale.length < RATIONALE_MIN_LENGTH) {
    throw serviceIncidentErrors.rationaleRequired(RATIONALE_MIN_LENGTH);
  }
  if (rationale.length > RATIONALE_MAX_LENGTH) {
    throw serviceIncidentErrors.rationaleTooLong(RATIONALE_MAX_LENGTH);
  }
  return rationale;
}

