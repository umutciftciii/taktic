import {
  MatchRoundSource,
  MatchRoundStatus,
  Prisma,
  ServiceRequestStatus,
} from '@prisma/client';
import { REQUEST_EXPIRY_DAYS } from '../src/modules/request-lifecycle/request-lifecycle.constants';

/**
 * REL-002 — test fixtures only: bring a request's Round 1 in step with request
 * columns a fixture wrote directly.
 *
 * Since Faz 2 the round is the authority and the application moves it through
 * explicit transitions (src/modules/match-rounds/match-round-transitions.ts).
 * A fixture that skips the application — `prisma.serviceRequest.update({
 * status: 'COMPLETED', matchedOfferId, ... })` to stage a finished job — leaves
 * the round where the birth trigger put it (OPEN). This helper applies the
 * Faz 1 mapping (request → Round 1, the M1 backfill's own rules) to that
 * round, so the staged request reads the same way through the round-aware
 * readers as one the application produced. It is the Faz 1 dual-write, kept
 * for the one place it is still the right tool: a fixture's shortcut.
 *
 * Not for application code: an application writer that needed this would be
 * a writer bypassing the round's own transitions.
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

/**
 * Writes the Faz 1 projection of the request onto its current round and
 * returns the round's id. Use after a fixture changes a request's lifecycle
 * columns directly.
 */
export async function alignRoundWithRequest(
  client: Prisma.TransactionClient,
  requestId: string,
): Promise<string> {
  const request = await client.serviceRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: MATCH_ROUND_REQUEST_SELECT,
  });

  await client.serviceRequestMatchRound.update({
    where: { id: request.currentRoundId },
    data: projectMatchRound(request),
  });

  return request.currentRoundId;
}
