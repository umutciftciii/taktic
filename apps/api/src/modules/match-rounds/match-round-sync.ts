import { MatchRoundOpenedBy, Prisma } from '@prisma/client';
import {
  MATCH_ROUND_REQUEST_SELECT,
  projectMatchRound,
  roundOneId,
} from './match-round-projection';

/**
 * REL-002 Faz 1 dual-write: brings the request's current round in step with
 * the request, in the caller's transaction, and returns the round's id.
 *
 * Call it **after** the writer's own request update, inside the same
 * transaction. The request row is then already locked by that update, so the
 * round is derived from the state this transaction commits — never from a
 * concurrent writer's — and a failure anywhere rolls the round back with
 * everything else: there is no half-written round.
 *
 * What it does not do is decide anything. The request's conditional updates
 * remain the guards; this only mirrors their outcome (see
 * `projectMatchRound`). That is why it writes unconditionally rather than
 * "where status = expected": in Faz 1 a mirror that refused would turn a
 * shadow record into a new way for an ordinary lifecycle action to fail.
 *
 * Round 1 is created here when the request has none yet — the creation path,
 * and any row written without it (a test fixture, a script, a request created
 * by the previous release between the migration and the new code going live).
 * Faz 1 knows only Round 1; Faz 2 replaces this with explicit round
 * transitions once rounds become authoritative.
 */
export async function syncCurrentMatchRound(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<string> {
  const request = await tx.serviceRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: MATCH_ROUND_REQUEST_SELECT,
  });

  const projection = projectMatchRound(request);
  const roundId = request.currentRoundId ?? roundOneId(request.id);

  await tx.serviceRequestMatchRound.upsert({
    where: { id: roundId },
    create: {
      id: roundId,
      requestId: request.id,
      roundNumber: 1,
      openedBy: MatchRoundOpenedBy.REQUEST_CREATED,
      openedAt: request.submittedAt,
      ...projection,
    },
    update: projection,
  });

  if (request.currentRoundId === null) {
    await tx.serviceRequest.update({
      where: { id: request.id },
      data: { currentRoundId: roundId },
      select: { id: true },
    });
  }

  return roundId;
}

/**
 * The request's current round id for a write that attaches something to it
 * (an offer) without changing the request. Read-only when the round exists —
 * so two providers offering on the same request at once do not both write the
 * round row — and the Round 1 sync only for a request that has none.
 */
export async function currentMatchRoundId(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<string> {
  const request = await tx.serviceRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { currentRoundId: true },
  });

  return request.currentRoundId ?? syncCurrentMatchRound(tx, requestId);
}
