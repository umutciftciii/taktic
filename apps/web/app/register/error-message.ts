import { CREDENTIAL_REFUSAL_MESSAGES, isCredentialRefusal } from '../../lib/turnstile';

/**
 * One sentence per refusal the registration action can hand back, shared by
 * both screens so the two never drift into saying different things about the
 * same 409.
 *
 * `role-conflict` is deliberately its own answer rather than another
 * `duplicate`. "Bu e-posta veya telefon zaten kayıtlı" points somebody at the
 * sign-in screen, and their password cannot work there: the address is not on
 * an account of this kind at all. Neither message names the account holder or
 * says which kind holds the address — the API does not say either.
 */
export function registerErrorMessage(error: string): string {
  // SEC-AUTH-ABUSE-001: the security check and the throttle, worded the same
  // as on the sign-in screen.
  if (isCredentialRefusal(error)) {
    return CREDENTIAL_REFUSAL_MESSAGES[error];
  }

  if (error === 'role-conflict') {
    return 'Bu e-posta başka türde bir hesap için kullanılıyor.';
  }

  if (error === 'duplicate') {
    return 'Bu e-posta veya telefon zaten kayıtlı.';
  }

  return 'Bilgileri kontrol edin.';
}
