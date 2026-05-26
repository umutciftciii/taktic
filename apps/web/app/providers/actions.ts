'use server';

import { redirect } from 'next/navigation';
import { apiFetch, ProviderProfile } from '../../lib/api';

export async function createProviderAction(formData: FormData) {
  const provider = await apiFetch<ProviderProfile>('/providers', {
    method: 'POST',
    body: JSON.stringify(providerPayload(formData)),
  });

  redirect(`/providers/success?id=${provider.id}`);
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
