import { IsInt, IsNotEmpty, IsString, Matches, Max, Min } from 'class-validator';

export class MockPackagePaymentDto {
  @IsString()
  @IsNotEmpty()
  cardholderName!: string;

  @IsString()
  @IsNotEmpty()
  cardNumber!: string;

  @IsInt()
  @Min(1)
  @Max(12)
  expiryMonth!: number;

  @IsInt()
  @Min(0)
  expiryYear!: number;

  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv!: string;
}
