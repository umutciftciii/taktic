'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, ApiError } from '../../../lib/api';
import { clientForwardingHeaders } from '../../../lib/forwarded-for';
import { turnstileHeaders } from '../../../lib/turnstile';

/**
 * A provider proving its own account e-mail and telephone number
 * (AUTH-PROVIDER-CONTACT-001).
 *
 * None of the three actions carries an account id: the API routes behind them
 * take the account from the session. What travels back is a status word in the
 * query string — never a code, never a token, never a link. The Turnstile token
 * the send needs arrives as an argument from the client component that asked
 * the widget for it, and is carried in one header for that one call.
 *
 * `providerId` is only where the page lives; it names the screen to return to
 * and nothing about whose proof this is.
 */

const EMAIL_PARAM = 'email';
const PHONE_PARAM = 'phone';

export async function sendAccountEmailVerificationAction(providerId: string) {
  let status: string;
  try {
    await apiFetch('/auth/email-verification/resend', { method: 'POST' });
    status = 'sent';
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    status = 'failed';
  }

  redirect(profileUrl(providerId, EMAIL_PARAM, status));
}

export async function sendAccountPhoneCodeAction(providerId: string, turnstileToken: string | null) {
  const status = await callVerificationApi('/providers/me/phone-verification', undefined, {
    // The client's forwarded address, so the API's per-address budget counts
    // this provider and not the web server; the token in its one header.
    headers: { ...(await clientForwardingHeaders()), ...turnstileHeaders(turnstileToken) },
  });

  redirect(profileUrl(providerId, PHONE_PARAM, status === 'ok' ? 'sent' : status));
}

export async function verifyAccountPhoneCodeAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const code = readFormString(formData, 'code').trim();
  const status = await callVerificationApi(
    '/providers/me/phone-verification/verify',
    { code },
    { headers: await clientForwardingHeaders() },
  );

  revalidatePath(`/providers/${providerId}`);
  redirect(profileUrl(providerId, PHONE_PARAM, status === 'ok' ? 'verified' : status));
}

/** Maps the API result onto the small, safe vocabulary the card renders. */
async function callVerificationApi(
  path: string,
  body?: Record<string, string>,
  init: { headers?: Record<string, string> } = {},
) {
  try {
    await apiFetch(path, {
      method: 'POST',
      headers: init.headers ?? {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return 'ok';
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }

    if (error.status === 429) return 'rate-limited';
    if (error.status === 400) return 'invalid';
    if (error.status === 409) {
      return /ACCOUNT_PHONE_MISSING/.test(error.body) ? 'no-phone' : 'already-verified';
    }
    if (error.status === 403 && /TURNSTILE_/.test(error.body)) return 'challenge-failed';
    if (error.status === 503 && /TURNSTILE_UNAVAILABLE/.test(error.body)) return 'challenge-unavailable';
    return 'failed';
  }
}

function profileUrl(providerId: string, param: string, status: string): string {
  const params = new URLSearchParams({ [param]: status });
  return `/providers/${encodeURIComponent(providerId)}?${params.toString()}#hesap-iletisimi`;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
