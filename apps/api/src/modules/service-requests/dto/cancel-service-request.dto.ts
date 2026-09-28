import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /service-requests/:id/cancel`.
 *
 * No refund switch lives here, on purpose. A cancel through this endpoint
 * always gives the winning offer's credit back; keeping it spent is a
 * separate endpoint with its own permission and a required reason
 * ({@link WithholdWinnerRefundCancelDto}). A body that tries to carry such a
 * switch is refused by the global `forbidNonWhitelisted` pipe, so a missing or
 * stray field can never turn into "no refund".
 */
export class CancelServiceRequestDto {
  /**
   * The match the caller saw when it decided: the accepted offer's id, or ''
   * for "not matched". When present, the cancel is refused with 409 if the
   * request no longer looks like that — an operator who decided on an open
   * request does not silently end a match that appeared meanwhile.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  expectedMatchedOfferId?: string;
}

/** `POST /service-requests/:id/cancel/withhold-winner-refund`. */
export class WithholdWinnerRefundCancelDto {
  /** Why the winning offer's credit is kept. Required; kept in the cancellation audit only. */
  @IsString()
  @MaxLength(1000)
  reason!: string;

  /** Required here: a withheld refund is a decision about one specific match. */
  @IsString()
  @MaxLength(64)
  expectedMatchedOfferId!: string;
}
