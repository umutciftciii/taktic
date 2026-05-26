'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, OfferCreditPackage } from '../../lib/api';

export async function createCreditPackageAction(formData: FormData) {
  await apiFetch<OfferCreditPackage>('/credit-packages', {
    method: 'POST',
    body: JSON.stringify(packagePayload(formData)),
  });

  revalidatePath('/credit-packages');
}

export async function updateCreditPackageAction(formData: FormData) {
  const id = readFormString(formData, 'id');

  await apiFetch<OfferCreditPackage>(`/credit-packages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(packagePayload(formData)),
  });

  revalidatePath('/credit-packages');
}

export async function updateCreditPackageStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const isActive = readFormString(formData, 'isActive') === 'true';

  await apiFetch<OfferCreditPackage>(`/credit-packages/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath('/credit-packages');
}

function packagePayload(formData: FormData) {
  return {
    name: readFormString(formData, 'name'),
    slug: readFormString(formData, 'slug'),
    creditAmount: readFormNumber(formData, 'creditAmount'),
    priceAmount: readFormNumber(formData, 'priceAmount'),
    currency: readOptionalFormString(formData, 'currency') ?? 'TRY',
    description: readOptionalFormString(formData, 'description'),
    sortOrder: readFormNumber(formData, 'sortOrder'),
    isActive: readFormString(formData, 'isActive') !== 'false',
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

function readFormNumber(formData: FormData, key: string) {
  const value = Number(readFormString(formData, key));
  return Number.isFinite(value) ? value : 0;
}
