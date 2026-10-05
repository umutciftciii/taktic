import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Matches, Max, MinLength, Min } from 'class-validator';
import { CREDIT_LEDGER_INTEGER_MAX } from '../../../common/credit-limits';

export class ManualCreditTransactionDto {
  @IsInt()
  @Min(1)
  // The ledger's integer column; the balance bound is the service's, inside
  // the transaction that computes the balance.
  @Max(CREDIT_LEDGER_INTEGER_MAX)
  amount!: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  reason!: string;

  /**
   * CAMPAIGN-CREDIT-POLICY-001. One key per business operation, repeated on
   * every retry of that operation: the API moves the credit at most once per
   * key. Drawn by the client (a random UUID); never derived from the payload.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/)
  idempotencyKey!: string;
}
