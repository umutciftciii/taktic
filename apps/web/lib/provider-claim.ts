/**
 * Web-side view of the provider claim feature.
 *
 * The API is the authority on the flag — it refuses the endpoints and refuses
 * to boot on a bad value. This copy only decides what the screens say, so an
 * unreadable value degrades to "off": showing the guest form its old, softer
 * shape while the API happens to be stricter produces one clear refusal, which
 * is far better than a screen that promises an e-mail nothing will send.
 */
export function isProviderClaimEnabled(): boolean {
  return process.env.PROVIDER_CLAIM_ENABLED?.trim() === 'true';
}

/** Cookie carrying a claim token between screens so no URL ever has to. */
export const CLAIM_TOKEN_COOKIE = 'taktic_claim_token';

/** Cookie carrying the masked address the application confirmation shows. */
export const APPLY_HINT_COOKIE = 'taktic_apply_hint';

/**
 * Same shape the API's audit masking produces, so the two never disagree about
 * what an applicant is shown.
 */
export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!local || !domain) {
    return '***';
  }

  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
