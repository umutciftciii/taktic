import {
  MatchRoundSource,
  MatchRoundStatus,
  Prisma,
  ServiceRequestStatus,
} from '@prisma/client';
import { REQUEST_EXPIRY_DAYS } from '../request-lifecycle/request-lifecycle.constants';

/**
 * REL-002 Faz 1 — how a request's Round 1 follows from the request itself.
 *
 * In Faz 1 a request has exactly one matching cycle, and its round is a
 * *derived* record: every field below is a pure function of the request's own
 * columns (plus the matched offer's provider). The request stays the authority
 * and nothing reads the round yet. The same mapping is written three times on
 * purpose, and the consistency check is what holds them together:
 *
 *   - here, for every lifecycle write (`syncCurrentMatchRound`);
 *   - in SQL, for the M1 backfill
 *     (prisma/migrations/20261011120000_add_service_request_match_rounds);
 *   - in SQL again, as the read-only check
 *     (scripts/ops/rel-002-round-consistency.sql).
 *
 * No date is invented anywhere: a NULL on the request is a NULL on the round.
 */

/** Round 1's id: deterministic, so the backfill and the writers agree on it. */
export function roundOneId(requestId: string): string {
  return `mr1_${requestId}`;
}

/** The request columns the projection reads. */
export const MATCH_ROUND_REQUEST_SELECT = {
  id: true,
  status: true,
  currentRoundId: true,
  submittedAt: true,
  approvedAt: true,
  reminderSentAt: true,
  matchedOfferId: true,
  matchedAt: true,
  completedAt: true,
  cancelledAt: true,
  expiredAt: true,
  showcaseLeadId: true,
  directShowcaseProviderId: true,
  matchedOffer: { select: { providerId: true } },
} satisfies Prisma.ServiceRequestSelect;

export type MatchRoundRequestSource = Prisma.ServiceRequestGetPayload<{
  select: typeof MATCH_ROUND_REQUEST_SELECT;
}>;

/** The round fields a lifecycle write keeps in step with the request. */
export type MatchRoundProjection = {
  status: MatchRoundStatus;
  source: MatchRoundSource;
  publishedAt: Date | null;
  expiresAt: Date | null;
  reminderSentAt: Date | null;
  matchedAt: Date | null;
  matchedOfferId: string | null;
  matchedProviderId: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
};

/** Still in moderation's hands: the round exists, its offer period has not begun. */
const PRE_PUBLICATION_STATUSES = new Set<ServiceRequestStatus>([
  ServiceRequestStatus.DRAFT,
  ServiceRequestStatus.SUBMITTED,
  ServiceRequestStatus.IN_REVIEW,
]);

/** The request statuses whose round keeps the record of a match. */
const MATCH_CARRYING_STATUSES = new Set<ServiceRequestStatus>([
  ServiceRequestStatus.MATCHED,
  ServiceRequestStatus.COMPLETED,
  ServiceRequestStatus.CANCELLED,
]);

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * request.status → round.status. REJECTED stays OPEN: a report's removal can be
 * reopened into the same round, and the request's status is what keeps it off
 * the market meanwhile.
 */
export function roundStatusFor(status: ServiceRequestStatus): MatchRoundStatus {
  switch (status) {
    case ServiceRequestStatus.MATCHED:
      return MatchRoundStatus.MATCHED;
    case ServiceRequestStatus.COMPLETED:
      return MatchRoundStatus.COMPLETED;
    case ServiceRequestStatus.CANCELLED:
      return MatchRoundStatus.CANCELLED;
    case ServiceRequestStatus.EXPIRED:
      return MatchRoundStatus.EXPIRED;
    default:
      return MatchRoundStatus.OPEN;
  }
}

export function projectMatchRound(request: MatchRoundRequestSource): MatchRoundProjection {
  const status = roundStatusFor(request.status);
  // The offer period's clock. `approvedAt` is refreshed by a re-approval and by
  // a reopen after removal, and the round follows it: today's semantics, not a
  // new one. NULL while the request is still in moderation, and NULL for a
  // legacy approval nobody recorded the time of.
  const publishedAt = PRE_PUBLICATION_STATUSES.has(request.status) ? null : request.approvedAt;
  const carriesMatch = MATCH_CARRYING_STATUSES.has(request.status) && request.matchedOfferId !== null;

  return {
    status,
    // Held for one business only while the vitrin gate is still up; a
    // released lead is an ordinary marketplace request.
    source:
      request.showcaseLeadId !== null && request.directShowcaseProviderId !== null
        ? MatchRoundSource.DIRECT_SHOWCASE
        : MatchRoundSource.MARKETPLACE,
    publishedAt,
    expiresAt: publishedAt ? new Date(publishedAt.getTime() + REQUEST_EXPIRY_DAYS * DAY_IN_MS) : null,
    reminderSentAt: request.reminderSentAt,
    matchedAt: carriesMatch ? request.matchedAt : null,
    matchedOfferId: carriesMatch ? request.matchedOfferId : null,
    matchedProviderId: carriesMatch ? (request.matchedOffer?.providerId ?? null) : null,
    completedAt: status === MatchRoundStatus.COMPLETED ? request.completedAt : null,
    cancelledAt: status === MatchRoundStatus.CANCELLED ? request.cancelledAt : null,
    expiredAt: status === MatchRoundStatus.EXPIRED ? request.expiredAt : null,
  };
}
