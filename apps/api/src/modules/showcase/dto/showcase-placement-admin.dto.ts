import { OfferAllowanceVoidReason } from '@prisma/client';
import { IsEnum, IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * The operator's note on a suspension.
 *
 * Required (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B): a suspension takes a
 * paid card off the air, and the provider is not told by mail — the note is
 * the only record of why. The minimum length is judged on the trimmed value by
 * the service ({@link SHOWCASE_PLACEMENT_SUSPEND_NOTE_MIN_LENGTH}), as the
 * cancellation's is, so whitespace is not a reason either.
 *
 * It is the only field. There is deliberately no `reason` — an operator's
 * action is `ADMIN_ACTION` by definition, and a body that could name a
 * different reason could name one that does not stop the clock, which would be
 * an operator quietly billing a provider for days the platform took away.
 */
export class ShowcasePlacementSuspendDto {
  @IsString()
  @MaxLength(500)
  note!: string;
}

/** The shortest suspension note, after trimming — the cancellation's rule. */
export const SHOWCASE_PLACEMENT_SUSPEND_NOTE_MIN_LENGTH = 10;

/**
 * The reason a cancellation is filed under.
 *
 * Required (ADMIN-DESTRUCTIVE-CONFIRMATION-001): a cancellation cannot be
 * undone and refunds nothing, and the note is what the person deciding about
 * the purchase's money later reads. The minimum length is judged on the
 * trimmed value by the service ({@link SHOWCASE_PLACEMENT_CANCEL_NOTE_MIN_LENGTH}),
 * so whitespace is not a reason either.
 *
 * There is no `refund` field and no amount. Cancelling ends the run and leaves
 * a flag for a person; the money is moved by that person, through the same
 * manual path a payment reversal takes.
 */
export class ShowcasePlacementCancelDto {
  @IsString()
  @MaxLength(500)
  note!: string;
}

/** The shortest cancellation note, after trimming — the vitrin rejection's rule. */
export const SHOWCASE_PLACEMENT_CANCEL_NOTE_MIN_LENGTH = 10;

/**
 * SHOWCASE-ALLOWANCE-004 — voiding a run's remaining free offers.
 *
 * `reasonCode` and `note` are the record of why: the code is one of a closed
 * set, the note is internal (10..1000 characters, judged trimmed by the
 * service) and neither is ever mailed to the provider.
 *
 * The three `expected*` figures are what the confirmation dialog showed — the
 * slots granted, the slots spent, the leads still waiting for a free answer —
 * posted back as a compare-and-set: if any of them moved in between, the void
 * is refused with 409 OFFER_ALLOWANCE_CHANGED instead of taking away a
 * different number of slots than the operator confirmed. Required, not
 * optional: a void nobody was shown the figures of is not a confirmed void.
 *
 * There is no `count`: there is no partial void. Everything left goes.
 */
export class ShowcaseAllowanceVoidDto {
  @IsEnum(OfferAllowanceVoidReason)
  reasonCode!: OfferAllowanceVoidReason;

  @IsString()
  @MaxLength(1000)
  note!: string;

  @IsInt()
  @Min(1)
  expectedQuotaTotal!: number;

  @IsInt()
  @Min(0)
  expectedQuotaUsed!: number;

  @IsInt()
  @Min(0)
  expectedOpenLeads!: number;
}

/** The shortest void note, after trimming — the DB CHECK's lower bound. */
export const SHOWCASE_ALLOWANCE_VOID_NOTE_MIN_LENGTH = 10;
