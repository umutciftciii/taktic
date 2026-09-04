'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiUrl, readApiMessage } from '../api-base';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../lib/password-policy';

/**
 * The two things a customer may change about their own account.
 *
 * Neither action carries an account id, and neither could use one: the API
 * routes behind them take the account from the session. What travels from this
 * process is the session cookie and the fields that were typed.
 */

export async function updateAccountProfileAction(formData: FormData) {
  const name = readFormString(formData, 'name').trim();
  const phone = readFormString(formData, 'phone').trim();
  // The select always posts the field, and its empty option is how somebody
  // says "no city on file". Sent as an empty string rather than omitted,
  // because the API reads an omitted field as "leave it as it was".
  const city = readFormString(formData, 'city').trim();

  const response = await accountFetch('/account/profile', {
    method: 'PATCH',
    body: JSON.stringify({ name, phone, city }),
  });

  if (!response.ok) {
    const params = new URLSearchParams({ error: '1' });
    const message = await readApiMessage(response);
    if (message) {
      params.set('errorMessage', message);
    }
    redirect(`/account/profile?${params.toString()}`);
  }

  redirect('/account/profile?saved=1');
}

/**
 * Changes the password, and never writes one anywhere it could be read back.
 *
 * The refusals travel as codes rather than as text, and the screen owns the
 * sentence each one prints. That is not only tidier: it is what guarantees no
 * fragment of what was typed can end up in a URL, in browser history, or in a
 * referrer header on the way to the next page.
 *
 * The three checks made here are the same ones the API makes, in the same
 * order. They are a courtesy that saves a round trip, not the rule — the server
 * repeats every one of them against the stored hash, which is the only place
 * "is this really your password" can be answered.
 */
export async function changePasswordAction(formData: FormData) {
  const currentPassword = readFormString(formData, 'currentPassword');
  const newPassword = readFormString(formData, 'password');
  const newPasswordConfirm = readFormString(formData, 'passwordConfirm');

  if (!currentPassword) {
    redirect('/account/password?error=current');
  }

  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
    redirect('/account/password?error=policy');
  }

  if (newPassword !== newPasswordConfirm) {
    redirect('/account/password?error=mismatch');
  }

  if (newPassword === currentPassword) {
    redirect('/account/password?error=same');
  }

  const response = await accountFetch('/account/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword, newPasswordConfirm }),
  });

  if (!response.ok) {
    redirect(`/account/password?error=${await passwordErrorCode(response)}`);
  }

  // The session this browser holds survived the change on purpose — every
  // other one was revoked — so the person stays where they are and is told so.
  redirect('/account/password?success=1');
}

/**
 * Which refusal it was, as a code the screen can print a sentence for.
 *
 * Everything the API can say at this point has already been narrowed by the
 * checks above: a 409 is an account with no password to change, and the only
 * 400 left is the current password not matching.
 */
async function passwordErrorCode(response: Response): Promise<string> {
  if (response.status === 409) {
    return 'nopassword';
  }

  if (response.status === 400) {
    return 'current';
  }

  if (response.status === 429) {
    return 'throttled';
  }

  return 'submit';
}

async function accountFetch(path: string, init: RequestInit): Promise<Response> {
  const cookieHeader = (await cookies()).toString();

  return fetch(`${apiUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
