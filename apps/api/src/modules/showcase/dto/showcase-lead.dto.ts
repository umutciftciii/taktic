import { ShowcaseLeadFallbackDecision, ShowcaseLeadUrgency } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateServiceRequestDto } from '../../service-requests/dto/create-service-request.dto';

/**
 * A direct vitrin lead: an ordinary request body, plus the one thing the card
 * asks that the marketplace form does not.
 *
 * ## What the body carries, and what it must not
 *
 * `urgencyBucket` is the customer's own choice between the two options the card
 * shows — "Acil — 3 saat içinde dönüş" and "Normal — 24 saat içinde dönüş",
 * rendered from the pinned version's own numbers. It is **not** derived from
 * `urgency`, and `urgency` is not derived from it. The two answer different
 * questions: `urgency` is when the work is wanted, this is how long the customer
 * is willing to wait for a reply, and a same-day job is very often one somebody
 * is happy to be called about tomorrow. A code table cannot tell those apart,
 * so the customer is asked.
 *
 * Three things are deliberately absent and are refused by
 * `forbidNonWhitelisted` if sent:
 *
 * - **`slaHours`** — the promise is the provider's, approved by an operator and
 *   read from the pinned version. A client that could name it could give itself
 *   a one-hour deadline on somebody else's business.
 * - **`placementId`** — resolved from the card id on the server. This endpoint
 *   needs no session, so a body that could name a placement could attach a lead
 *   to a run somebody else paid for.
 * - **`providerId`** — the same, one step further along.
 *
 * `phoneVerificationRequired` has no body field either: the proof is a consumed
 * `PhoneVerification` row for this telephone number, redeemed inside the
 * creation transaction.
 */
export class CreateShowcaseLeadDto extends CreateServiceRequestDto {
  @IsEnum(ShowcaseLeadUrgency)
  urgencyBucket!: ShowcaseLeadUrgency;
}

/** The customer's answer after their lead's deadline passed. */
export class ShowcaseFallbackDecisionDto {
  @IsEnum(ShowcaseLeadFallbackDecision)
  decision!: ShowcaseLeadFallbackDecision;
}

/** Asking for a code before a request exists. */
export class ShowcaseLeadVerificationStartDto {
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;
}

export class ShowcaseLeadVerificationConfirmDto extends ShowcaseLeadVerificationStartDto {
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

/** Filters on the provider's lead inbox and on the operator's list. */
export class ListShowcaseLeadsDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;
}
