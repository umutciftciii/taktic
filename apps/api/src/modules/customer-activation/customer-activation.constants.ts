import { readPublicWebBaseUrl } from '../../common/public-urls';

export const CUSTOMER_ACTIVATION_TOKEN_TTL_HOURS = 72;
export const CUSTOMER_ACTIVATION_PATH = '/activate-customer';

/**
 * Re-exported rather than reimplemented.
 *
 * This used to be its own copy of "where does the web application live", with
 * its own list of environment variables and its own localhost fallback. Every
 * link the platform mails now comes from one place — see
 * {@link readPublicWebBaseUrl} — so a deployment cannot end up with an
 * activation link on one host and a reset link on another. The variables it
 * reads and the development fallback are unchanged; what is new is that a
 * production deployment has to declare its address instead of silently getting
 * localhost.
 */
export function getWebAppBaseUrl(): string {
  return readPublicWebBaseUrl();
}
