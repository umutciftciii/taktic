/**
 * The admin panel's Turnstile contract (SEC-AUTH-ABUSE-001): the very same one
 * the web application reads, from @taktic/shared (turnstile-web.ts). The panel
 * renders the widget for its sign-in and password-reset forms under the same
 * TURNSTILE_MODE / TURNSTILE_SITE_KEY / APP_ENVIRONMENT rule, and the API
 * judges the token under the same rules for both.
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
