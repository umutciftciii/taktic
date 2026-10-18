/**
 * The address an account holds once its own address has been released for
 * somebody else (STG-003B, `release-customer-email`).
 *
 * `.invalid` is reserved by RFC 2606 and can never be delivered to, so the
 * placeholder is unique (it names the account id), satisfies
 * `User_email_normalized_check` (lower case, no surrounding space) and cannot
 * reach a stranger whatever a future code path does with it.
 *
 * The domain is also the marker the notification dispatcher reads: a message
 * addressed to an account whose address is released is not sent, whichever
 * address the message itself carries. That is what keeps the request's own
 * `customerEmail` snapshot untouched — it still says where earlier mail went —
 * while nothing new reaches the address the account gave up.
 */
export const RELEASED_EMAIL_DOMAIN = 'account.invalid';

export function releasedCustomerEmail(userId: string): string {
  return `released-${userId.trim().toLowerCase()}@${RELEASED_EMAIL_DOMAIN}`;
}

export function isReleasedEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${RELEASED_EMAIL_DOMAIN}`);
}
