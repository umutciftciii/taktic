'use server';

import { redirect } from 'next/navigation';
import { apiUrl } from '../api-base';

/**
 * Always lands on the same confirmation.
 *
 * The API answers identically whether or not the address is registered, and
 * this action keeps that property: a different screen for "no such account"
 * would put the enumeration oracle back in the product the API just removed.
 * Even a transport failure is reported as sent, because "we could not reach the
 * mail service for this address" is the same signal by another name.
 */
export async function requestPasswordResetAction(formData: FormData) {
  const email = readFormString(formData, 'email').trim();

  if (email) {
    try {
      await fetch(`${apiUrl}/auth/password-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
        cache: 'no-store',
      });
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  redirect('/sifre-unuttum?sent=1');
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
