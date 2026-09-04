import { PROVIDER_INVITE_PATH } from '../modules/provider-invites/provider-invites.constants';
import { getAdminAppBaseUrl } from '../modules/users/admin-invite.constants';
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

/**
 * The contact-sharing disclosure this repository serves itself.
 * `apps/web/app/sozlesmeler/iletisim-paylasimi`.
 *
 * It exists so the platform's own default is a text that provably exists: the
 * page is in the repository, versioned with it, and served by the same origin
 * the customer is already on. A deployment with its own published legal page
 * points CONTACT_DISCLOSURE_URL at it instead.
 */
export const CONTACT_DISCLOSURE_PATH = '/sozlesmeler/iletisim-paylasimi';

export function contactDisclosureUrl(): string {
  return publicWebUrl(CONTACT_DISCLOSURE_PATH);
}

/**
 * Where a provider application invitation lands.
 * `apps/web/app/provider-invite/[token]`.
 *
 * The only link in this file whose secret is a *path segment* rather than a
 * query value. That is a deliberate difference from the reset and verification
 * links: this URL is handed to a business by an operator — pasted into a
 * message, read aloud, retyped — and a path reads as an address while a query
 * string reads as machinery somebody may helpfully trim. It is encoded here so
 * a token can no more break out of its segment than out of a parameter.
 */
export function providerInviteUrl(rawToken: string): string {
  return publicWebUrl(`${PROVIDER_INVITE_PATH}/${encodeURIComponent(rawToken)}`);
}

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

/** The customer's own support ticket. `apps/web/app/destek/[ticketId]`. */
export function customerSupportTicketUrl(ticketId: string): string {
  return publicWebUrl(`/destek/${encodeURIComponent(ticketId)}`);
}

/**
 * One ticket in the operator queue. `apps/admin/app/support/[id]`.
 *
 * The only link in this file that is *not* on the web application, and it is
 * here rather than in a file of its own because the rule the module comment
 * states applies to it unchanged: the path is a literal this repository owns,
 * and a route that moves has to break the build rather than a link in an
 * operator's inbox. It is used by exactly the two support notifications that
 * go to the support mailbox — a customer is never sent here.
 */
export function adminSupportTicketUrl(ticketId: string): string {
  return `${getAdminAppBaseUrl()}/support/${encodeURIComponent(ticketId)}`;
}
