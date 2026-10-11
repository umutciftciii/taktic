import { ConflictException, HttpStatus } from '@nestjs/common';
import limits from '@taktic/shared/limits.json';
import {
  MatchRoundOpenedBy,
  MatchRoundSource,
  MatchRoundStatus,
  Prisma,
  ServiceRequestStatus,
} from '@prisma/client';
import { REQUEST_EXPIRY_DAYS } from '../request-lifecycle/request-lifecycle.constants';

/**
 * REL-002 Faz 2 — the match round is the matching core's authority.
 *
 * Every change to a round goes through one of the transitions below, and each
 * is a conditional UPDATE on the round's own status: the round refuses a move
 * its current state does not allow, whatever the caller believed it read. The
 * request's `status`, `matchedOfferId` and `matchedAt` are the round's
 * *projection* — kept for the many readers that ask "is this request matched,
 * and to whom" — and every writer moves the round and the projection in the
 * same transaction.
 *
 * Round 1 is born with its request in the database
 * (`ServiceRequest_round_one_at_birth`, M2). Round N+1 is opened by
 * {@link openNextRound}, which only the service-issue transaction calls
 * (Faz 3), and never past {@link MAX_AUTO_MATCH_ROUNDS}.
 *
 * A transition that matches nothing throws {@link roundStateChangedException}.
 * Callers run inside a transaction whose own guard (the request's conditional
 * update) normally refuses first with a business-specific answer; reaching the
 * round's refusal means the round and the request disagree, and the whole
 * transaction rolls back rather than writing half a transition.
 */

export const OFFER_ROUND_CLOSED_CODE = 'OFFER_ROUND_CLOSED';
export const MATCH_ROUND_STATE_CHANGED_CODE = 'MATCH_ROUND_STATE_CHANGED';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * REL-002 decision 3: rounds the platform opens on its own. A service issue on
 * Round 1 or 2 reopens the request into the next round; on Round 3 it does
 * not — the request goes to MATCH_REVIEW and only staff may open Round 4+
 * (Faz 5). Shared with the web through `limits.json`.
 */
export const MAX_AUTO_MATCH_ROUNDS: number = limits.maxAutoMatchRounds;

/** The round id Round N ≥ 2 is written with: deterministic, like Round 1's `mr1_`. */
export function nextRoundId(requestId: string, roundNumber: number): string {
  if (!Number.isInteger(roundNumber) || roundNumber < 2) {
    throw new Error(`Only Round 2 and later are opened by the application (got ${roundNumber})`);
  }
  return `mr${roundNumber}_${requestId}`;
}

/** The round columns the matching core reads. */
export const CURRENT_ROUND_SELECT = {
  id: true,
  requestId: true,
  roundNumber: true,
  status: true,
  source: true,
  publishedAt: true,
  expiresAt: true,
  reminderSentAt: true,
  matchedOfferId: true,
  matchedProviderId: true,
  matchedAt: true,
  failedAt: true,
} satisfies Prisma.ServiceRequestMatchRoundSelect;

export type CurrentRound = Prisma.ServiceRequestMatchRoundGetPayload<{
  select: typeof CURRENT_ROUND_SELECT;
}>;

/**
 * 409 for an action on an offer whose round is not the request's current OPEN
 * round: a stale screen, a later round already running, or a round that ended
 * (matched, expired, cancelled).
 */
export function offerRoundClosedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: OFFER_ROUND_CLOSED_CODE,
    message: 'Bu teklifin ait olduğu eşleşme turu kapandı; işlem yapılamaz.',
  });
}

export const PROVIDER_EXCLUDED_CODE = 'PROVIDER_EXCLUDED';

/**
 * 409 for an action by a provider excluded from the request (REL-002 Faz 3):
 * their match on it failed, and they may not act on it again. Surfaces only
 * where the provider already knows the request (their own stale offer); a
 * provider who merely guessed an id gets the ordinary 404.
 */
export function providerExcludedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PROVIDER_EXCLUDED_CODE,
    message: 'Bu talepteki eşleşmeniz müşteri bildirimiyle sona erdi; bu talep için işlem yapamazsınız.',
  });
}

/**
 * The `Offer_round_open_guard` trigger (M3) refuses an offer INSERT with a
 * message that starts with its code. Turns that refusal into the 409 the
 * application itself would have answered; `null` for any other error.
 */
export function offerInsertGuardException(error: unknown): ConflictException | null {
  const message = error instanceof Error ? error.message : '';
  if (message.includes(`${PROVIDER_EXCLUDED_CODE}:`)) {
    return providerExcludedException();
  }
  if (message.includes(`${OFFER_ROUND_CLOSED_CODE}:`)) {
    return offerRoundClosedException();
  }
  return null;
}

/** 409 for a round transition whose expected state no longer holds. */
export function roundStateChangedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: MATCH_ROUND_STATE_CHANGED_CODE,
    message: 'Talebin eşleşme turu bu işlem sırasında değişti; lütfen sayfayı yenileyin.',
  });
}

/**
 * The request (with its projection columns) and its current round, read in
 * the caller's transaction. `null` when there is no such request.
 */
export async function getCurrentRound(tx: Prisma.TransactionClient, requestId: string) {
  return tx.serviceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      currentRoundId: true,
      matchedOfferId: true,
      currentRound: { select: CURRENT_ROUND_SELECT },
    },
  });
}

export type RequestWithCurrentRound = NonNullable<Awaited<ReturnType<typeof getCurrentRound>>>;

/** Like {@link getCurrentRound}, for a request the caller already proved exists. */
export async function getCurrentRoundOrThrow(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<RequestWithCurrentRound> {
  const current = await getCurrentRound(tx, requestId);
  if (!current) {
    throw new Error(`Service request ${requestId} disappeared inside its own transaction`);
  }
  return current;
}

/**
 * Whether an offer of round `offerRoundId` may still be acted on: it must
 * belong to the request's current round, and that round must be OPEN.
 */
export function isOfferRoundCurrentAndOpen(
  offerRoundId: string,
  current: Pick<RequestWithCurrentRound, 'currentRoundId' | 'currentRound'>,
): boolean {
  return (
    offerRoundId === current.currentRoundId && current.currentRound.status === MatchRoundStatus.OPEN
  );
}

/** Throws {@link offerRoundClosedException} unless {@link isOfferRoundCurrentAndOpen}. */
export function assertOfferRoundCurrentAndOpen(
  offerRoundId: string,
  current: Pick<RequestWithCurrentRound, 'currentRoundId' | 'currentRound'>,
): void {
  if (!isOfferRoundCurrentAndOpen(offerRoundId, current)) {
    throw offerRoundClosedException();
  }
}

/**
 * When the round's offer period starts, given the request's moderation state:
 * NULL while the request is still in moderation, the request's `approvedAt`
 * once it is past it (a re-approval or a reopen after removal refreshes it —
 * today's semantics). NULL stays NULL: a legacy approval nobody recorded the
 * time of is never guessed, and the scheduler never touches such a round.
 */
export function roundPublicationFor(status: ServiceRequestStatus, approvedAt: Date | null): Date | null {
  return status === ServiceRequestStatus.DRAFT ||
    status === ServiceRequestStatus.SUBMITTED ||
    status === ServiceRequestStatus.IN_REVIEW
    ? null
    : approvedAt;
}

async function transition(
  tx: Prisma.TransactionClient,
  where: Prisma.ServiceRequestMatchRoundWhereInput & { id: string },
  data: Prisma.ServiceRequestMatchRoundUncheckedUpdateManyInput,
): Promise<void> {
  const moved = await tx.serviceRequestMatchRound.updateMany({ where, data });
  if (moved.count !== 1) {
    throw roundStateChangedException();
  }
}

/**
 * Starts (or, with `null`, suspends) an OPEN round's offer period: the clock
 * expiry and the reminder run on. `expiresAt` is the snapshot
 * `publishedAt + REQUEST_EXPIRY_DAYS`.
 */
export function publishRound(
  tx: Prisma.TransactionClient,
  input: { roundId: string; publishedAt: Date | null },
) {
  return transition(
    tx,
    { id: input.roundId, status: MatchRoundStatus.OPEN },
    {
      publishedAt: input.publishedAt,
      expiresAt: input.publishedAt
        ? new Date(input.publishedAt.getTime() + REQUEST_EXPIRY_DAYS * DAY_IN_MS)
        : null,
    },
  );
}

/** Who an OPEN round is open to: a vitrin lead's gate, or the whole market. */
export function setRoundSource(
  tx: Prisma.TransactionClient,
  input: { roundId: string; source: MatchRoundSource },
) {
  return transition(tx, { id: input.roundId, status: MatchRoundStatus.OPEN }, { source: input.source });
}

/** OPEN → MATCHED, naming the winner. Only an OPEN round with no winner moves. */
export function transitionRoundToMatched(
  tx: Prisma.TransactionClient,
  input: { roundId: string; offerId: string; providerId: string; matchedAt: Date },
) {
  return transition(
    tx,
    { id: input.roundId, status: MatchRoundStatus.OPEN, matchedOfferId: null },
    {
      status: MatchRoundStatus.MATCHED,
      matchedOfferId: input.offerId,
      matchedProviderId: input.providerId,
      matchedAt: input.matchedAt,
    },
  );
}

/** MATCHED → COMPLETED. The winner stays recorded. */
export function transitionRoundToCompleted(
  tx: Prisma.TransactionClient,
  input: { roundId: string; completedAt: Date },
) {
  return transition(
    tx,
    { id: input.roundId, status: MatchRoundStatus.MATCHED },
    { status: MatchRoundStatus.COMPLETED, completedAt: input.completedAt },
  );
}

/**
 * OPEN or MATCHED → CANCELLED. A matched round keeps its winner as history,
 * exactly as the request keeps `matchedOfferId`.
 */
export function transitionRoundToCancelled(
  tx: Prisma.TransactionClient,
  input: { roundId: string; cancelledAt: Date },
) {
  return transition(
    tx,
    { id: input.roundId, status: { in: [MatchRoundStatus.OPEN, MatchRoundStatus.MATCHED] } },
    { status: MatchRoundStatus.CANCELLED, cancelledAt: input.cancelledAt },
  );
}

/**
 * MATCHED → FAILED (REL-002 Faz 3): the customer reported a service issue.
 * Conditional on the round still being MATCHED to this very offer, so a
 * completion, a cancel or a second report that got there first leaves this
 * one matching nothing. The winner stays recorded; the incident says why.
 */
export function transitionRoundToFailed(
  tx: Prisma.TransactionClient,
  input: { roundId: string; offerId: string; incidentId: string; failedAt: Date },
) {
  return transition(
    tx,
    { id: input.roundId, status: MatchRoundStatus.MATCHED, matchedOfferId: input.offerId },
    { status: MatchRoundStatus.FAILED, failedAt: input.failedAt, failureIncidentId: input.incidentId },
  );
}

/**
 * Opens Round N+1 after Round N failed (REL-002 Faz 3). A marketplace round
 * always: the failed provider is excluded and a vitrin lead's gate is gone.
 *
 * `publishedAt` is the moment the new round's offer period starts, or NULL
 * when the request must first pass moderation (a direct lead that never did,
 * §20) — then the ordinary publish path stamps it later. `expiresAt` is the
 * snapshot `publishedAt + REQUEST_EXPIRY_DAYS`; `reminderSentAt` starts NULL.
 *
 * Inserted, not upserted: the `(requestId, roundNumber)` unique and the
 * one-active-round partial unique refuse a second Round N+1, whatever raced.
 */
export async function openNextRound(
  tx: Prisma.TransactionClient,
  input: { requestId: string; failedRoundNumber: number; openedAt: Date; publishedAt: Date | null },
): Promise<{ id: string; roundNumber: number }> {
  const roundNumber = input.failedRoundNumber + 1;
  if (roundNumber > MAX_AUTO_MATCH_ROUNDS) {
    throw new Error(`Round ${roundNumber} is past the automatic limit (${MAX_AUTO_MATCH_ROUNDS})`);
  }
  const round = await tx.serviceRequestMatchRound.create({
    data: {
      id: nextRoundId(input.requestId, roundNumber),
      requestId: input.requestId,
      roundNumber,
      status: MatchRoundStatus.OPEN,
      source: MatchRoundSource.MARKETPLACE,
      openedBy: MatchRoundOpenedBy.SERVICE_ISSUE,
      openedAt: input.openedAt,
      publishedAt: input.publishedAt,
      expiresAt: input.publishedAt
        ? new Date(input.publishedAt.getTime() + REQUEST_EXPIRY_DAYS * DAY_IN_MS)
        : null,
    },
    select: { id: true, roundNumber: true },
  });
  return round;
}

/** OPEN (with no winner) → EXPIRED. */
export function transitionRoundToExpired(
  tx: Prisma.TransactionClient,
  input: { roundId: string; expiredAt: Date },
) {
  return transition(
    tx,
    { id: input.roundId, status: MatchRoundStatus.OPEN, matchedOfferId: null },
    { status: MatchRoundStatus.EXPIRED, expiredAt: input.expiredAt },
  );
}

/**
 * The reminder claim, on the round: conditional on the round still being
 * OPEN, unreminded and published before the cutoff, so of two schedulers
 * racing on one round exactly one claims it. Returns whether this call did.
 */
export async function claimRoundReminder(
  tx: Prisma.TransactionClient,
  input: { roundId: string; cutoff: Date; now: Date },
): Promise<boolean> {
  const claimed = await tx.serviceRequestMatchRound.updateMany({
    where: {
      id: input.roundId,
      status: MatchRoundStatus.OPEN,
      reminderSentAt: null,
      publishedAt: { not: null, lte: input.cutoff },
    },
    data: { reminderSentAt: input.now },
  });
  return claimed.count === 1;
}
