import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MANUAL_REFUND_REASON_CODES } from '../refund-policy';

/**
 * The body of an administrator's manual refund.
 *
 * There is no `override` flag any more. It used to exist so an operator could
 * overrule the automatic policy's recommendation; the manual path no longer
 * consults that policy at all, so the flag was a checkbox in front of a
 * decision the operator had already taken.
 */
export class RefundOfferCreditDto {
  @IsString()
  @IsIn([...MANUAL_REFUND_REASON_CODES])
  reasonCode!: string;

  /**
   * The operator's own words. Stored on the audit row and read by admin
   * surfaces only — it may carry internal detail, so it never reaches the
   * provider's mail or panel.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
