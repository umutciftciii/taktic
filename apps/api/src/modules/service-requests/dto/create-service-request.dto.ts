import {
  Allow,
  ArrayMaxSize,
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
import { IsKnownTurkishLocation } from '../../locations/turkish-location.validator';

export class CreateServiceRequestAnswerDto {
  @IsString()
  @IsNotEmpty()
  questionKey!: string;

  @Allow()
  value!: unknown;
}

/**
 * One step of a routed flow. See RouterSelectionDto in the categories module —
 * this is the same shape, repeated here so the request payload stays a single
 * self-describing DTO.
 */
export class CreateServiceRequestRouterSelectionDto {
  @IsString()
  @IsNotEmpty()
  questionKey!: string;

  @IsString()
  @IsNotEmpty()
  optionKey!: string;
}

export class CreateServiceRequestDto {
  /**
   * The category the customer started from.
   *
   * For an ordinary service that is also the category the request lands on, and
   * the field means exactly what it has always meant — every client written
   * before routing existed keeps working unchanged. For a router it is the
   * entry point, and `routerSelections` below say which way the customer went.
   */
  @IsString()
  @IsNotEmpty()
  categorySlug!: string;

  /**
   * The option keys the customer picked at each routing step, in order.
   *
   * They are not a destination: the API looks each one up in the stored router
   * rules and derives the final category itself. Omitted — which is what an
   * unrouted request sends, and what every existing client sends — the entry
   * category is the final one.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateServiceRequestRouterSelectionDto)
  routerSelections?: CreateServiceRequestRouterSelectionDto[];

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

  /**
   * Carries the relation check for the whole triple: the district has to be a
   * district of `city`, and `neighborhood` — when one is given — a
   * neighbourhood of that district. The names themselves are stored
   * canonically, so a valid spelling variant is accepted and normalised rather
   * than refused.
   */
  @IsString()
  @IsNotEmpty()
  @IsKnownTurkishLocation()
  city!: string;

  /** Required on a request: a customer's job happens in one district. */
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
