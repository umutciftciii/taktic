'use server';

import { redirect } from 'next/navigation';
import { CheckoutSessionResponse, apiFetch } from '../../../../lib/api';

/**
 * Starts a credit package checkout.
 *
 * The form carries a package id and nothing else: the credit amount, the price
 * and the currency are resolved server-side from the active package and
 * snapshotted onto the purchase, so nothing a browser can edit changes what is
 * bought or what it costs.
 *
 * Where the provider is sent next is the API's answer, not this action's guess.
 * A provider with a hosted page returns its URL; the mock provider returns
 * null, and the flow lands on the in-app test checkout screen exactly as it
 * always has. Neither destination loads credits — the purchase stays PENDING
 * until a signature-verified webhook (or the mock payment endpoint) says
 * otherwise.
 */
export async function createPackagePurchaseAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const packageId = readFormString(formData, 'packageId');
  const providerNote = readOptionalFormString(formData, 'providerNote');

  const session = await apiFetch<CheckoutSessionResponse>(
    `/providers/${providerId}/checkout-sessions`,
    {
      method: 'POST',
      body: JSON.stringify({ packageId, providerNote }),
    },
  );

  if (session.checkout.url) {
    redirect(session.checkout.url);
  }

  redirect(`/providers/${providerId}/package-purchases/${session.purchase.id}/checkout`);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
