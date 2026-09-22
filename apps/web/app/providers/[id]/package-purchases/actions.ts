'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, CheckoutSessionResponse, apiFetch } from '../../../../lib/api';
import { clientForwardingHeaders } from '../../../../lib/forwarded-for';

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
 *
 * CMP-006 PR-A. When the screen rendered the purchase-terms consent box (the
 * API's gate is open), the form also carries `termsAccepted` and the served
 * `termsVersion`. Only then does this action add them to the body, together
 * with what the API records as evidence of the acceptance: the browser's user
 * agent, the forwarded client address (only where WEB_TRUST_PROXY allows it)
 * and the `web` channel label. Without a version on the form the request is
 * byte-for-byte what it always was.
 */
export async function createPackagePurchaseAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const packageId = readFormString(formData, 'packageId');
  const providerNote = readOptionalFormString(formData, 'providerNote');
  const termsVersion = readOptionalFormString(formData, 'termsVersion');

  let session: CheckoutSessionResponse;
  try {
    session = await apiFetch<CheckoutSessionResponse>(
      `/providers/${providerId}/checkout-sessions`,
      termsVersion
        ? {
            method: 'POST',
            headers: await termsEvidenceHeaders(),
            body: JSON.stringify({
              packageId,
              providerNote,
              termsAccepted: formData.get('termsAccepted') === 'true',
              termsVersion,
            }),
          }
        : {
            method: 'POST',
            body: JSON.stringify({ packageId, providerNote }),
          },
    );
  } catch (error) {
    const refusal = readTermsRefusal(error);
    if (refusal) {
      redirect(returnPath(providerId, readFormString(formData, 'returnTo'), refusal));
    }
    throw error;
  }

  if (session.checkout.url) {
    redirect(session.checkout.url);
  }

  redirect(`/providers/${providerId}/package-purchases/${session.purchase.id}/checkout`);
}

async function termsEvidenceHeaders(): Promise<Record<string, string>> {
  const userAgent = (await headers()).get('user-agent')?.trim();
  return {
    ...(await clientForwardingHeaders()),
    ...(userAgent ? { 'user-agent': userAgent } : {}),
    'x-taktic-client-channel': 'web',
  };
}

/** The two purchase-terms refusals, as the query value the page reads. */
function readTermsRefusal(error: unknown): 'onay-gerekli' | 'guncellendi' | null {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return null;
  }
  try {
    const code = (JSON.parse(error.body) as { code?: unknown }).code;
    if (code === 'PURCHASE_TERMS_NOT_ACCEPTED') return 'onay-gerekli';
    if (code === 'PURCHASE_TERMS_VERSION_STALE') return 'guncellendi';
  } catch {
    // Not JSON: not one of ours.
  }
  return null;
}

/** Back to the screen the form was on — one of two known pages, never a supplied URL. */
function returnPath(providerId: string, returnTo: string, refusal: string) {
  return returnTo === 'subscriptions'
    ? `/providers/${providerId}/subscriptions?kosullar=${refusal}#satin-al`
    : `/providers/${providerId}/credits?kosullar=${refusal}#paketler`;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
