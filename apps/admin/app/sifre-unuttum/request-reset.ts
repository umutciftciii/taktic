const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * ADMIN-AUTH-001: the panel's "Şifremi Unuttum" submission.
 *
 * Always lands on the same confirmation. The API answers identically whether
 * or not the address is registered — or is a staff account at all — and this
 * keeps that property: a different screen for "no such operator" would make
 * the panel's sign-in page a directory of who works here. Even a transport
 * failure is reported as sent, because "we could not reach the mail service
 * for this address" is the same signal by another name.
 *
 * The address is never echoed back into the URL it redirects to.
 */
export async function requestPasswordReset(formData: FormData): Promise<string> {
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

  return '/sifre-unuttum?sent=1';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
