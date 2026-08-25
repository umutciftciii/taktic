import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PROVIDER_CLAIM_DISABLED_CODE } from './provider-claim.config';

/**
 * The complete, closed set of refusals the claim flow may return.
 *
 * Two rules shape the wording behind each of these.
 *
 * 1. Nothing here confirms or denies that a particular application or account
 *    exists. A caller holding a wrong, expired or already-spent token gets one
 *    indistinguishable answer, and a caller whose e-mail belongs to somebody
 *    else is told only that this address cannot be used — never who holds it.
 * 2. Nothing here echoes an address, a token or a URL back. The screens have a
 *    masked address from the validate call; these messages carry no identifiers
 *    at all.
 */
export const PROVIDER_CLAIM_ERROR_CODES = [
  PROVIDER_CLAIM_DISABLED_CODE,
  'CLAIM_TOKEN_INVALID',
  'CLAIM_NOT_AVAILABLE',
  'CLAIM_ALREADY_COMPLETED',
  'EMAIL_BELONGS_TO_CUSTOMER',
  'EMAIL_NOT_ELIGIBLE',
  'LOGIN_REQUIRED',
  'PROVIDER_ALREADY_HAS_PROFILE',
  'PASSWORD_REQUIRED',
  'CLAIM_RATE_LIMITED',
  'CLAIM_EMAIL_MISSING',
] as const;

export type ProviderClaimErrorCode = (typeof PROVIDER_CLAIM_ERROR_CODES)[number];

export function providerClaimDisabledException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PROVIDER_CLAIM_DISABLED_CODE,
    message: 'Başvuru sahiplenme şu anda kapalı.',
  });
}

/**
 * One answer for "no such token", "expired" and "already used".
 *
 * Splitting them would turn the endpoint into an oracle: a caller could feed it
 * candidate tokens and learn which ones ever existed. The person who actually
 * received the link needs to do the same thing in all three cases anyway — ask
 * for a new one.
 */
export function claimTokenInvalidException() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: 'CLAIM_TOKEN_INVALID',
    message: 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir bağlantı isteyin.',
  });
}

/**
 * The application is in a state that cannot be claimed — a draft, a rejected or
 * a suspended one. Deliberately does not say which: the holder of a link has no
 * business learning a moderation outcome from an error code.
 */
export function claimNotAvailableException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CLAIM_NOT_AVAILABLE',
    message: 'Bu başvuru şu anda sahiplenilemiyor.',
  });
}

export function claimAlreadyCompletedException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CLAIM_ALREADY_COMPLETED',
    message: 'Bu başvuru zaten bir hesaba bağlanmış.',
  });
}

/**
 * The application's address already belongs to a customer account.
 *
 * A platform account carries exactly one role and User.email is globally
 * unique, so there is no PROVIDER account this address could become and no
 * customer that may quietly turn into one. The way out is an admin correcting
 * the application's address and issuing a fresh invitation.
 */
export function emailBelongsToCustomerException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'EMAIL_BELONGS_TO_CUSTOMER',
    message:
      'Bu e-posta adresi bir müşteri hesabına ait. Başvurunuz için farklı bir e-posta adresi ' +
      'kullanılması gerekiyor.',
  });
}

/** Any other account kind that cannot own a provider profile. */
export function emailNotEligibleException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'EMAIL_NOT_ELIGIBLE',
    message: 'Bu e-posta adresi ile başvuru sahiplenilemiyor.',
  });
}

/**
 * A provider account already exists for this address, and the caller is not
 * signed in as it. The token is deliberately left unspent: the person still has
 * to come back through it after logging in.
 */
export function claimLoginRequiredException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'LOGIN_REQUIRED',
    message: 'Bu e-posta ile bir hizmet veren hesabı var. Devam etmek için giriş yapın.',
  });
}

export function providerAlreadyHasProfileException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PROVIDER_ALREADY_HAS_PROFILE',
    message: 'Bu hesap için zaten bir hizmet veren profili var.',
  });
}

export function claimPasswordRequiredException() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: 'PASSWORD_REQUIRED',
    message: 'Devam etmek için bir şifre belirleyin.',
  });
}

/**
 * One 429 for every budget.
 *
 * Which limit was hit — the per-application one or the per-address one — is
 * itself information: a distinguishable answer would let a caller measure how
 * many invitations an application has already received. Both paths raise this.
 */
export function claimRateLimitedException() {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: 'CLAIM_RATE_LIMITED',
      message: 'Çok fazla davet isteği gönderildi. Lütfen daha sonra tekrar deneyin.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Admin path only: the application carries no contact address, so there is
 * nowhere to send an invitation. Applications submitted before the flag was
 * turned on can be in this state; the fix is to correct the address first.
 */
export function claimEmailMissingException() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'CLAIM_EMAIL_MISSING',
    message: 'Bu başvuruda e-posta adresi yok. Önce başvurunun e-posta adresini girin.',
  });
}
