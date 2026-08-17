import {
  Allow,
  IsArray,
  IsBoolean,
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

  /**
   * Whether the customer confirmed having read the linked contact-sharing
   * disclosure. Only consulted while CONTACT_SHARING_ENABLED is true; with the
   * feature off it is ignored and the request keeps null disclosure fields,
   * exactly as before this field existed.
   */
  @IsOptional()
  @IsBoolean()
  contactDisclosureAccepted?: boolean;

  /**
   * The disclosure version the form displayed. Compared for equality against
   * the configured one — like expectedCreditCost on an offer it never decides
   * what is stored, it only catches a form filled in before a version bump.
   */
  @IsOptional()
  @IsString()
  contactDisclosureVersion?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateServiceRequestAnswerDto)
  answers!: CreateServiceRequestAnswerDto[];
}
