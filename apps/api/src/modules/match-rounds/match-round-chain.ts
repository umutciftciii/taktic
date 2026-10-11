import { MatchRoundStatus, Prisma, ServiceRequestStatus } from '@prisma/client';

/**
 * REL-002 Faz 2 — "the current match", read the same way by every surface
 * that opens something because of a match: contact details, the message
 * thread, the match mail's contact rows.
 *
 * A match is live only when the request *and* its current round agree that it
 * is MATCHED to this offer. The request's projection alone is not enough (it
 * is the round's shadow), and the round alone is not enough (a request
 * cancelled from MATCHED keeps the round's history). Records that hang off a
 * match — the contact reveal, the thread — are looked up by the current
 * round's id, so a reveal or thread of an earlier round is never the current
 * one, whoever asks.
 */
export const MATCH_CHAIN_REQUEST_SELECT = {
  status: true,
  matchedOfferId: true,
  currentRoundId: true,
  currentRound: { select: { status: true, matchedOfferId: true } },
} satisfies Prisma.ServiceRequestSelect;

export type MatchChainRequest = Prisma.ServiceRequestGetPayload<{
  select: typeof MATCH_CHAIN_REQUEST_SELECT;
}>;

/** The offer the request's current round is MATCHED to, or `null` when it is not matched. */
export function currentMatchedOfferId(request: MatchChainRequest): string | null {
  if (
    request.status !== ServiceRequestStatus.MATCHED ||
    request.currentRound.status !== MatchRoundStatus.MATCHED ||
    !request.matchedOfferId ||
    request.currentRound.matchedOfferId !== request.matchedOfferId
  ) {
    return null;
  }
  return request.matchedOfferId;
}

/** The current round's reveal (one per round), or `null`. */
export function findCurrentRoundReveal<S extends Prisma.ContactRevealEventSelect>(
  client: Prisma.TransactionClient,
  request: Pick<MatchChainRequest, 'currentRoundId'>,
  select: S,
) {
  return client.contactRevealEvent.findUnique({
    where: { roundId: request.currentRoundId },
    select,
  });
}
