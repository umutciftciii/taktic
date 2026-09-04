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
import { MaxCodeUnitLength } from '../../../common/max-code-unit-length.validator';
import { SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH } from '../../../common/service-request-limits';
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

  /**
   * Whether the customer is naming somebody other than themselves as the
   * contact for this request.
   *
   * Only ever consulted for a signed-in customer, and only they can set it
   * meaningfully: with it false — which is what an omitted field means, and
   * what every client written before this existed sends — the API derives the
   * three contact fields below from the account and ignores whatever the body
   * carried. A visitor with no session is unaffected: they have no account to
   * derive anything from, so their own contact details are still the request's.
   */
  @IsOptional()
  @IsBoolean()
  useAlternateContact?: boolean;

  /*
   * The three contact fields are optional *in shape only*.
   *
   * They stopped being mandatory here because a signed-in customer on the
   * default path posts none of them — the server reads the account instead —
   * and a DTO cannot see who is signed in. Whether they are required, and for
   * whom, is decided by ServiceRequestsService.resolveContactDetails: a guest
   * and an alternate contact must still carry all three, and an empty string
   * is still refused here rather than silently accepted as "not given".
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerPhone?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  customerEmail?: string;

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

  /**
   * Bounded so a request cannot carry an unbounded blob of text. The number is
   * @taktic/shared's, which is also what the public form's counter and its
   * `maxLength` read — the client-side stop is a courtesy, this is the rule.
   *
   * Counted in UTF-16 code units — `string.length` — which is the unit the
   * browser applies to the textarea's `maxLength` and the unit the counter
   * beside it reports. `@MaxLength` would count code points instead and let an
   * emoji-heavy description past a limit the form had already refused, so the
   * rule uses {@link MaxCodeUnitLength}.
   */
  @IsOptional()
  @IsString()
  @MaxCodeUnitLength(SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH)
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
