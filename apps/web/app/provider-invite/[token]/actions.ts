'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { APPLY_HINT_COOKIE, isProviderClaimEnabled, maskEmail } from '../../../lib/provider-claim';
import { appCookieOptions } from '../../session-cookie';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Submits an invited application.
 *
 * The token arrives as a hidden form field and leaves as a JSON body field. It
 * is never appended to the API's query string and never put into a redirect: the
 * link the business was given already spends one path segment on it, and every
 * further place it appeared — a `Referer` header, an access log, an error URL —
 * would be a place a credential outlived the one request that needed it.
 *
 * `categoryIds` is deliberately absent from the payload. Which service this
 * application is for is the invitation's to say; the API's DTO has no field for
 * it, and a body that invents one is refused outright.
 */
export async function submitInvitedApplicationAction(formData: FormData) {
  const token = readFormString(formData, 'token').trim();

  if (!token) {
    redirect('/');
  }

  const email = readOptionalFormString(formData, 'email');

  // The session travels with the submission, like it does on the open form. An
  // invitation followed by a signed-in provider produces an application that
  // account already owns — and one followed by a customer is refused outright,
  // which is far better than quietly recording a guest application under the
  // nose of somebody who is signed in as somebody else.
  const cookieHeader = (await cookies()).toString();

  const response = await fetch(`${apiUrl}/provider-invites/applications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    cache: 'no-store',
    body: JSON.stringify({
      token,
      businessName: readFormString(formData, 'businessName'),
      contactName: readFormString(formData, 'contactName'),
      phone: readFormString(formData, 'phone'),
      email,
      city: readFormString(formData, 'city'),
      district: readFormString(formData, 'district'),
      addressNote: readOptionalFormString(formData, 'addressNote'),
      description: readOptionalFormString(formData, 'description'),
      serviceAreas: [
        {
          city: readFormString(formData, 'serviceAreaCity'),
          district: readOptionalFormString(formData, 'serviceAreaDistrict'),
          neighborhood: readOptionalFormString(formData, 'serviceAreaNeighborhood'),
        },
      ],
    }),
  });

  if (!response.ok) {
    // Back to the same screen with a short code, never with the API's own text.
    // The screen re-validates the link on the way in, so a link that died while
    // the form was open renders as the ordinary 404 rather than as a form with
    // an error above it.
    redirect(inviteUrl(token, failureCode(response.status, await safeReadBody(response))));
  }

  // Same as the open application form: the confirmation screen needs to say
  // which mailbox to check, and it learns that from a short-lived cookie rather
  // than from a query string, so no address reaches a URL or a browser history.
  if (isProviderClaimEnabled() && email) {
    (await cookies()).set(
      APPLY_HINT_COOKIE,
      maskEmail(email),
      await appCookieOptions({ path: '/providers/success', maxAge: 600 }),
    );
  }

  redirect('/providers/success');
}

/** The invitation screen's own URL, which is the only place the token lives. */
function inviteUrl(token: string, error: string): string {
  return `/provider-invite/${encodeURIComponent(token)}?error=${error}`;
}

/**
 * Maps a refusal onto a short, stable code the screen explains in its own
 * words.
 *
 * `used` is the one refusal that is not a validation problem: it means somebody
 * else applied through this link between the form being opened and being sent.
 * It has to be a distinct sentence, because "try again" is exactly what the
 * applicant must not do.
 */
function failureCode(status: number, body: string): string {
  if (status === 409 && body.includes('PROVIDER_INVITE_ALREADY_USED')) {
    return 'used';
  }

  if (body.includes('PROVIDER_EMAIL_REQUIRED')) {
    return 'email';
  }

  if (status === 403) {
    return 'account';
  }

  if (status === 409) {
    return 'account';
  }

  return 'invalid';
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
