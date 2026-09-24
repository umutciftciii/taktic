'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, ProviderProfile } from '../../lib/api';
import { businessRegistrationErrorKey, readBusinessRegistration } from '../../lib/business-registration';
import { APPLY_HINT_COOKIE, isProviderClaimEnabled, maskEmail } from '../../lib/provider-claim';
import { readServiceAreas } from '../../lib/service-area-payload';
import { appCookieOptions } from '../session-cookie';

export async function createProviderAction(formData: FormData) {
  const registration = readBusinessRegistration(formData);
  const payload = {
    ...providerPayload(formData),
    businessRegistrationType: registration.type,
    businessRegistrationNumber: registration.number,
  };

  let provider: ProviderProfile;
  try {
    provider = await apiFetch<ProviderProfile>('/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // CMP-006 PR-C: a refused registration comes back as a closed code; the
    // number itself is never put in the URL.
    const registrationError = error instanceof ApiError && error.status === 400 ? businessRegistrationErrorKey(error.body) : null;
    if (registrationError) {
      redirect(`/providers/register?error=${registrationError}`);
    }

    if (error instanceof ApiError && error.status === 400 && error.body.includes('EMAIL')) {
      redirect('/providers/register?error=email');
    }

    // The address on a guest application is where the claim link is mailed and
    // where the provider account would be opened, so the API refuses one filed
    // against a customer's address. Nothing was written and nothing was sent;
    // the applicant needs a different address, not a retry.
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.body.includes('EMAIL_ROLE_CONFLICT')
    ) {
      redirect('/providers/register?error=role-conflict');
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
    (await cookies()).set(
      APPLY_HINT_COOKIE,
      maskEmail(payload.email),
      // Scoped to the one screen that reads it. The options — `Secure`
      // included — come from the shared helper, so this cookie is not a second
      // place deciding whether the connection requires TLS. See
      // session-cookie.ts.
      await appCookieOptions({ path: '/providers/success', maxAge: 600 }),
    );
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
    serviceAreas: readServiceAreas(formData),
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

/**
 * The provider replacing their own business registration (CMP-006 PR-C). Its
 * own route and its own form: the profile save does not carry it. A refusal
 * comes back as a closed code in the query string — never the number.
 */
export async function updateBusinessRegistrationAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const registration = readBusinessRegistration(formData);

  try {
    await apiFetch('/providers/me/business-registration', {
      method: 'PUT',
      body: JSON.stringify(registration),
    });
  } catch (error) {
    const key = error instanceof ApiError && error.status === 400 ? businessRegistrationErrorKey(error.body) : null;
    if (key) {
      redirect(`/providers/${id}/edit?registrationError=${key}#isletme-kaydi`);
    }
    throw error;
  }

  redirect(`/providers/${id}?registration=saved`);
}
