import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Max, MinLength, Min } from 'class-validator';
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
}
