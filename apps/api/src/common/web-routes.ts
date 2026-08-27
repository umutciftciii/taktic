import { publicWebUrl } from './public-urls';

/**
 * The web application's routes, as the API knows them.
 *
 * Every link this service mails is built here rather than assembled at the call
 * site, for one reason: a route that changes has to break the build, not a link
 * in somebody's inbox. Each function below corresponds to a page that exists in
 * apps/web/app — there is no route in this file that the web application does
 * not serve.
 *
 * Paths are literals owned by this repository; only query values are dynamic,
 * and they go through URLSearchParams (see publicWebUrl) so a token can never
 * break out of the parameter it is in.
 */

/** Where a reset link lands. `apps/web/app/sifre-sifirla`. */
export const PASSWORD_RESET_PATH = '/sifre-sifirla';

/** Where a verification link lands. `apps/web/app/e-posta-dogrula`. */
export const EMAIL_VERIFICATION_PATH = '/e-posta-dogrula';

export function passwordResetUrl(rawToken: string): string {
  return publicWebUrl(PASSWORD_RESET_PATH, { token: rawToken });
}

export function emailVerificationUrl(rawToken: string): string {
  return publicWebUrl(EMAIL_VERIFICATION_PATH, { token: rawToken });
}

/** The customer's own account page. `apps/web/app/account/profile`. */
export function customerAccountUrl(): string {
  return publicWebUrl('/account/profile');
}

/** The customer's request, with its offers. `apps/web/app/requests/[id]/offers`. */
export function customerRequestUrl(requestId: string): string {
  return publicWebUrl(`/requests/${encodeURIComponent(requestId)}/offers`);
}

/** The provider's own dashboard, and the page a signed-out provider is sent to. */
export function providerAccountUrl(): string {
  return publicWebUrl('/providers/me');
}

/** `apps/web/app/providers/[id]/edit`. Only reachable by the application's owner. */
export function providerProfileUrl(providerId: string): string {
  return publicWebUrl(`/providers/${encodeURIComponent(providerId)}/edit`);
}

/** The provider's matching-request list. `apps/web/app/providers/[id]/requests`. */
export function providerRequestsUrl(providerId: string): string {
  return publicWebUrl(`/providers/${encodeURIComponent(providerId)}/requests`);
}

/** One matching request. `apps/web/app/providers/[id]/requests/[requestId]`. */
export function providerRequestUrl(providerId: string, requestId: string): string {
  return publicWebUrl(
    `/providers/${encodeURIComponent(providerId)}/requests/${encodeURIComponent(requestId)}`,
  );
}

/** One of the provider's own offers. `apps/web/app/providers/[id]/offers/[offerId]`. */
export function providerOfferUrl(providerId: string, offerId: string): string {
  return publicWebUrl(
    `/providers/${encodeURIComponent(providerId)}/offers/${encodeURIComponent(offerId)}`,
  );
}

/** The provider's credit balance and history. `apps/web/app/providers/[id]/credits`. */
export function providerCreditsUrl(providerId: string): string {
  return publicWebUrl(`/providers/${encodeURIComponent(providerId)}/credits`);
}
