import {
  Allow,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateServiceRequestAnswerDto {
  @IsString()
  @IsNotEmpty()
  questionKey!: string;

  @Allow()
  value!: unknown;
}

export class CreateServiceRequestDto {
  @IsString()
  @IsNotEmpty()
  categorySlug!: string;

  @IsString()
  @IsNotEmpty()
  customerName!: string;

  @IsString()
  @IsNotEmpty()
  customerPhone!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  customerEmail!: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsString()
  @IsNotEmpty()
  district!: string;

  @IsOptional()
  @IsString()
  neighborhood?: string | null;

  @IsOptional()
  @IsString()
  addressNote?: string | null;

  // budgetMin / budgetMax are stored in the currency's minor unit (kuruş for TRY)
  // and are nullable when the customer does not specify a budget. When provided,
  // the value must represent at least one whole currency unit (>= 100 minor units).
  @IsOptional()
  @IsInt()
  @Min(100)
  budgetMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(100)
  budgetMax?: number | null;

  @IsOptional()
  @IsString()
  preferredDate?: string | null;

  @IsOptional()
  @IsString()
  urgency?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateServiceRequestAnswerDto)
  answers!: CreateServiceRequestAnswerDto[];
}
