'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, ProviderProfile } from '../../lib/api';
import { APPLY_HINT_COOKIE, isProviderClaimEnabled, maskEmail } from '../../lib/provider-claim';

export async function createProviderAction(formData: FormData) {
  const payload = providerPayload(formData);

  let provider: ProviderProfile;
  try {
    provider = await apiFetch<ProviderProfile>('/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 400 && error.body.includes('EMAIL')) {
      redirect('/providers/register?error=email');
    }

    throw error;
  }

  // The confirmation screen used to carry the new application's id in its URL.
  // It is gone: the id is not a secret but it is not a credential either, and a
  // link somebody pastes into a chat should not name a record at all. What the
  // screen needs instead — which mailbox to check — travels in a short-lived
  // cookie rather than a query string, so no address of any form ends up in a
  // URL, a browser history or a server log.
  if (isProviderClaimEnabled() && payload.email) {
    (await cookies()).set(APPLY_HINT_COOKIE, maskEmail(payload.email), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/providers/success',
      maxAge: 600,
    });
  }

  redirect('/providers/success');
}

export async function updateProviderAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<ProviderProfile>(`/providers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(providerPayload(formData)),
  });

  redirect(`/providers/${id}`);
}

function providerPayload(formData: FormData) {
  return {
    businessName: readFormString(formData, 'businessName'),
    contactName: readFormString(formData, 'contactName'),
    phone: readFormString(formData, 'phone'),
    email: readOptionalFormString(formData, 'email'),
    city: readFormString(formData, 'city'),
    district: readFormString(formData, 'district'),
    addressNote: readOptionalFormString(formData, 'addressNote'),
    description: readOptionalFormString(formData, 'description'),
    categoryIds: formData.getAll('categoryIds').filter((value): value is string => typeof value === 'string'),
    serviceAreas: [
      {
        city: readFormString(formData, 'serviceAreaCity'),
        district: readOptionalFormString(formData, 'serviceAreaDistrict'),
        neighborhood: readOptionalFormString(formData, 'serviceAreaNeighborhood'),
      },
    ],
  };
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
