import {
  Allow,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  @IsOptional()
  @IsString()
  customerEmail?: string | null;

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

  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
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
