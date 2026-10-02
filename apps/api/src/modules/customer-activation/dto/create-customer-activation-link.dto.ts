import { IsBoolean, IsOptional } from 'class-validator';

/**
 * `POST /customers/:id/activation-link`.
 *
 * `replaceExisting` is the operator's explicit consent to void a link that is
 * still live (unused and unexpired). Without it the API refuses to issue over
 * a live link with 409 ACTIVATION_LINK_ALREADY_ACTIVE and writes nothing; the
 * admin panel sends it only after the reissue confirmation's proof verified
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2). Whether a live link exists is
 * the API's own answer, read under the issue lock — never the caller's claim.
 */
export class CreateCustomerActivationLinkDto {
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}
