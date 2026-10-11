import { randomUUID } from 'node:crypto';
import { Prisma, ProviderIncidentDecision, ProviderReliabilityReviewStatus } from '@prisma/client';
import {
  customerSignal,
  PROVIDER_RESPONSE_SLA_HOURS,
  RELIABILITY_REVIEW_AT,
  RELIABILITY_WARNING_AT,
  reliabilityLevel,
  windowStart,
  type CustomerSignal,
  type ReliabilityLevel,
} from './service-incident-policy';

/**
 * REL-002 Faz 4 — the canonical reads of the incident domain.
 *
 * Every count is computed from the incidents at the moment it is asked; no
 * counter is stored anywhere. What counts is the **effective** decision: the
 * adjudication the incident's `effectiveAdjudicationId` names (the head of an
 * explicit, append-only chain). A correction moves the head, so a corrected
 * confirmation stops counting the moment the correction commits, and its
 * history stays.
 */

type Client = Prisma.TransactionClient;

export type EffectiveIncidentDecision =
  | { decision: 'PENDING'; adjudicationId: null; sequence: null }
  | { decision: ProviderIncidentDecision; adjudicationId: string; sequence: number };

/**
 * The one answer to "what is this incident's decision now": PENDING with no
 * adjudication, otherwise the head of the chain. `null` when the incident does
 * not exist.
 */
export async function effectiveIncidentDecision(
  client: Client,
  incidentId: string,
): Promise<EffectiveIncidentDecision | null> {
  const incident = await client.providerServiceIncident.findUnique({
    where: { id: incidentId },
    select: { effectiveAdjudication: { select: { id: true, decision: true, sequence: true } } },
  });
  if (!incident) {
    return null;
  }
  const head = incident.effectiveAdjudication;
  return head
    ? { decision: head.decision, adjudicationId: head.id, sequence: head.sequence }
    : { decision: 'PENDING', adjudicationId: null, sequence: null };
}

export type ProviderReliabilitySummary = {
  windowDays: number;
  windowStart: Date;
  confirmed: number;
  dismissed: number;
  pending: number;
  total: number;
  /** Incidents in the window the provider answered; `responseRate` is this over `total` (null when 0). */
  responded: number;
  responseRate: number | null;
  /** Answered after the 72-hour window. */
  lateResponses: number;
  /** Undecided, unanswered, and past the 72-hour window now. */
  overdueResponses: number;
  level: ReliabilityLevel;
  thresholds: { warningAt: number; reviewAt: number };
};

type SummaryRow = {
  confirmed: bigint;
  dismissed: bigint;
  pending: bigint;
  total: bigint;
  responded: bigint;
  late: bigint;
  overdue: bigint;
};

/**
 * One provider's rolling-window reliability. A single index range scan on
 * `(providerId, reportedAt)` and a primary-key probe per incident for its head.
 */
export async function providerReliabilitySummary(
  client: Client,
  providerId: string,
  now: Date,
): Promise<ProviderReliabilitySummary> {
  const since = windowStart(now);
  const sla = Prisma.raw(`interval '${PROVIDER_RESPONSE_SLA_HOURS} hours'`);
  const [row] = await client.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE a."decision" = 'CONFIRMED')            AS confirmed,
      count(*) FILTER (WHERE a."decision" = 'DISMISSED')            AS dismissed,
      count(*) FILTER (WHERE i."effectiveAdjudicationId" IS NULL)   AS pending,
      count(*)                                                      AS total,
      count(*) FILTER (WHERE i."providerRespondedAt" IS NOT NULL)   AS responded,
      count(*) FILTER (WHERE i."providerRespondedAt" > i."reportedAt" + ${sla}) AS late,
      count(*) FILTER (WHERE i."providerRespondedAt" IS NULL AND i."effectiveAdjudicationId" IS NULL
                         AND i."reportedAt" + ${sla} < ${now})       AS overdue
    FROM "ProviderServiceIncident" i
    LEFT JOIN "ProviderIncidentAdjudication" a ON a."id" = i."effectiveAdjudicationId"
    WHERE i."providerId" = ${providerId} AND i."reportedAt" >= ${since}
  `);
  const total = Number(row?.total ?? 0);
  const confirmed = Number(row?.confirmed ?? 0);
  const responded = Number(row?.responded ?? 0);
  return {
    windowDays: Math.round((now.getTime() - since.getTime()) / 86_400_000),
    windowStart: since,
    confirmed,
    dismissed: Number(row?.dismissed ?? 0),
    pending: Number(row?.pending ?? 0),
    total,
    responded,
    responseRate: total > 0 ? responded / total : null,
    lateResponses: Number(row?.late ?? 0),
    overdueResponses: Number(row?.overdue ?? 0),
    level: reliabilityLevel(confirmed),
    thresholds: { warningAt: RELIABILITY_WARNING_AT, reviewAt: RELIABILITY_REVIEW_AT },
  };
}

/**
 * Effective CONFIRMED incidents of one provider in the window — the number
 * every threshold reads. A model query, not raw SQL, so inside a Serializable
 * transaction a serialization failure surfaces as P2034 and is retried
 * (`runSerializable`); a raw query's would be P2010.
 */
export function effectiveConfirmedCount(client: Client, providerId: string, now: Date): Promise<number> {
  return client.providerServiceIncident.count({
    where: {
      providerId,
      reportedAt: { gte: windowStart(now) },
      effectiveAdjudication: { is: { decision: ProviderIncidentDecision.CONFIRMED } },
    },
  });
}

/**
 * Effective CONFIRMED counts in the window for every provider that has at
 * least `atLeast` of them (the reliability queue, a list's risk column). Reads
 * the partial index of confirmed incidents; the projection it filters on is
 * held equal to the effective decision by the database, and the join re-checks
 * it.
 */
export async function confirmedCountsByProvider(
  client: Client,
  now: Date,
  options: { atLeast?: number; providerIds?: readonly string[] } = {},
): Promise<Map<string, number>> {
  const atLeast = options.atLeast ?? 1;
  const providerFilter =
    options.providerIds && options.providerIds.length > 0
      ? Prisma.sql`AND i."providerId" IN (${Prisma.join(options.providerIds)})`
      : Prisma.empty;
  if (options.providerIds && options.providerIds.length === 0) {
    return new Map();
  }
  const rows = await client.$queryRaw<{ providerId: string; confirmed: bigint }[]>(Prisma.sql`
    SELECT i."providerId" AS "providerId", count(*) AS confirmed
    FROM "ProviderServiceIncident" i
    JOIN "ProviderIncidentAdjudication" a ON a."id" = i."effectiveAdjudicationId" AND a."decision" = 'CONFIRMED'
    WHERE i."status" = 'CONFIRMED' AND i."reportedAt" >= ${windowStart(now)} ${providerFilter}
    GROUP BY i."providerId"
    HAVING count(*) >= ${atLeast}
  `);
  return new Map(rows.map((row) => [row.providerId, Number(row.confirmed)]));
}

export type CustomerReportSummary = {
  windowDays: number;
  total: number;
  confirmed: number;
  dismissed: number;
  pending: number;
  /** dismissed / (confirmed + dismissed); null with no decided report. */
  dismissedRatio: number | null;
  /**
   * Admin-only. Never blocks, restricts, deprioritises or hides anything —
   * no code path reads it except the admin projections.
   */
  signal: CustomerSignal | null;
};

/** One customer's service-issue reports in the window, by effective decision. */
export async function customerReportSummary(
  client: Client,
  customerUserId: string,
  now: Date,
): Promise<CustomerReportSummary> {
  const since = windowStart(now);
  const [row] = await client.$queryRaw<{ total: bigint; confirmed: bigint; dismissed: bigint; pending: bigint }[]>(Prisma.sql`
    SELECT
      count(*)                                                    AS total,
      count(*) FILTER (WHERE a."decision" = 'CONFIRMED')          AS confirmed,
      count(*) FILTER (WHERE a."decision" = 'DISMISSED')          AS dismissed,
      count(*) FILTER (WHERE i."effectiveAdjudicationId" IS NULL) AS pending
    FROM "ProviderServiceIncident" i
    LEFT JOIN "ProviderIncidentAdjudication" a ON a."id" = i."effectiveAdjudicationId"
    WHERE i."customerUserId" = ${customerUserId} AND i."reportedAt" >= ${since}
  `);
  const confirmed = Number(row?.confirmed ?? 0);
  const dismissed = Number(row?.dismissed ?? 0);
  const decided = confirmed + dismissed;
  return {
    windowDays: Math.round((now.getTime() - since.getTime()) / 86_400_000),
    total: Number(row?.total ?? 0),
    confirmed,
    dismissed,
    pending: Number(row?.pending ?? 0),
    dismissedRatio: decided > 0 ? dismissed / decided : null,
    signal: customerSignal({ confirmed, dismissed }),
  };
}

/**
 * Opens the provider's reliability review if its effective confirmed count is
 * at the review threshold and none is unresolved — idempotently: the partial
 * unique on unresolved reviews makes a concurrent second opener a no-op.
 * Returns the id of the review this call opened, or null.
 *
 * Never closes or deletes a review: a correction that lowers the count leaves
 * an open review (and its history) for staff to resolve.
 */
export async function ensureReliabilityReview(
  tx: Client,
  input: { providerId: string; triggerIncidentId: string; now: Date },
): Promise<string | null> {
  const confirmed = await effectiveConfirmedCount(tx, input.providerId, input.now);
  if (confirmed < RELIABILITY_REVIEW_AT) {
    return null;
  }
  // INSERT … ON CONFLICT DO NOTHING (no target: the partial unique on
  // unresolved reviews is one of the conflicts it absorbs). A model call, so a
  // serialization failure is retried like every other write here.
  const id = randomUUID();
  const created = await tx.providerReliabilityReview.createMany({
    data: [
      {
        id,
        providerId: input.providerId,
        status: ProviderReliabilityReviewStatus.OPEN,
        triggerIncidentId: input.triggerIncidentId,
        openedAt: input.now,
        openedBySystem: true,
      },
    ],
    skipDuplicates: true,
  });
  return created.count === 1 ? id : null;
}

/** The provider's unresolved review, if any. */
export function unresolvedReview(client: Client, providerId: string) {
  return client.providerReliabilityReview.findFirst({
    where: { providerId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    select: { id: true, status: true, openedAt: true, triggerIncidentId: true, acknowledgedAt: true },
  });
}
