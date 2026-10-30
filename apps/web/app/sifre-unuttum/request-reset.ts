import { apiUrl } from '../api-base';
import { clientForwardingHeaders } from '../../lib/forwarded-for';
import { credentialRefusalOf, readTurnstileFormToken, turnstileHeaders } from '../../lib/turnstile';

/**
 * Always lands on the same confirmation.
 *
 * The API answers identically whether or not the address is registered, and
 * this action keeps that property: a different screen for "no such account"
 * would put the enumeration oracle back in the product the API just removed.
 * Even a transport failure is reported as sent, because "we could not reach the
 * mail service for this address" is the same signal by another name.
 *
 * The one exception is the security check and the throttle (SEC-AUTH-ABUSE-001):
 * the API answers those before it looks at the address at all, so saying
 * "the check failed, try again" reveals nothing — and claiming "sent" for a
 * request that was never processed would leave the person waiting for a mail
 * that is not coming.
 */
export async function requestPasswordReset(formData: FormData): Promise<string> {
  const email = readFormString(formData, 'email').trim();

  if (email) {
    try {
      const response = await fetch(`${apiUrl}/auth/password-reset`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await clientForwardingHeaders()),
          ...turnstileHeaders(readTurnstileFormToken(formData)),
        },
        body: JSON.stringify({ email }),
        cache: 'no-store',
      });
      const refusal = await credentialRefusalOf(response);
      if (refusal) {
        return `/sifre-unuttum?error=${refusal}`;
      }
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  return '/sifre-unuttum?sent=1';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
