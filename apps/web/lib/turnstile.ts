/**
 * The web's Turnstile contract lives in @taktic/shared (turnstile-web.ts) since
 * SEC-AUTH-ABUSE-001, so the admin panel reads the same rules; this module
 * keeps the import path every web caller already uses.
 */
export {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_ACTIONS,
  TURNSTILE_CHALLENGE_FAILED,
  TURNSTILE_FORM_FIELD,
  TURNSTILE_TOKEN_HEADER,
  credentialRefusalOf,
  isCredentialRefusal,
  isTurnstileRefusalCode,
  readTurnstileFormToken,
  readTurnstileWebConfig,
  resolveTestTurnstileToken,
  turnstileHeaders,
} from '@taktic/shared';
export type { CredentialRefusal, TurnstileAction, TurnstileTestOverride, TurnstileWebConfig } from '@taktic/shared';
