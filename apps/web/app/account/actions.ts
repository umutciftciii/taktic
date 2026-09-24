'use server';

import { redirect } from 'next/navigation';
import { readApiMessage } from '../api-base';
import { accountFetch, readFormString } from './account-fetch';

/**
 * The two things a customer may change about their own account. The profile
 * is saved here; the password form posts to `/account/password/submit` — see
 * change-password.ts.
 *
 * Neither carries an account id, and neither could use one: the API
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
