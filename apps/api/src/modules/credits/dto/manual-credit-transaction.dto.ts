import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, MinLength, Min } from 'class-validator';

export class ManualCreditTransactionDto {
  @IsInt()
  @Min(1)
  amount!: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  reason!: string;
}
