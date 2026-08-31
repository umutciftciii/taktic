'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch } from '../../../../lib/api';

export type SubscriptionActionState = { error: string | null; notice: string | null };

/**
 * Turns automatic renewal on or off for one period.
 *
 * The API refuses to turn it on while no payment adapter can charge a stored
 * payment method, and it says so in a sentence written for the provider. This
 * action shows that sentence rather than a generic failure: "we cannot renew
 * this for you automatically" is the whole point of the refusal, and a provider
 * who reads "something went wrong" would try again tomorrow.
 */
export async function setAutoRenewAction(
  _state: SubscriptionActionState,
  formData: FormData,
): Promise<SubscriptionActionState> {
  const providerId = readFormString(formData, 'providerId');
  const entitlementId = readFormString(formData, 'entitlementId');
  const enabled = formData.get('enabled') === 'true';

  try {
    await apiFetch(`/providers/${providerId}/entitlements/${entitlementId}/auto-renew`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  } catch (error) {
    return { error: readApiMessage(error), notice: null };
  }

  revalidatePath(`/providers/${providerId}/subscriptions`);
  return {
    error: null,
    notice: enabled
      ? 'Otomatik yenileme açıldı.'
      : 'Otomatik yenileme kapatıldı. Mevcut döneminiz bitiş tarihine kadar aynen devam eder.',
  };
}

/**
 * Cancels the next charge.
 *
 * Never the period itself: the API leaves `endAt` where it is, and the wording
 * here says so, because "iptal et" reads like "I lose it now" to most people.
 */
export async function cancelAutoRenewAction(
  _state: SubscriptionActionState,
  formData: FormData,
): Promise<SubscriptionActionState> {
  const providerId = readFormString(formData, 'providerId');
  const entitlementId = readFormString(formData, 'entitlementId');

  try {
    await apiFetch(`/providers/${providerId}/entitlements/${entitlementId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    return { error: readApiMessage(error), notice: null };
  }

  revalidatePath(`/providers/${providerId}/subscriptions`);
  return {
    error: null,
    notice:
      'Yenileme iptal edildi. Mevcut dönem bitiş tarihine kadar kullanılmaya devam eder.',
  };
}

/**
 * The API's own message when there is one.
 *
 * Every refusal this screen can provoke carries a Turkish sentence written for
 * the provider; anything else is a fault, and gets the neutral fallback.
 */
function readApiMessage(error: unknown): string {
  if (error instanceof ApiError && error.body) {
    try {
      const parsed = JSON.parse(error.body) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    } catch {
      // Not JSON. Fall through to the neutral message.
    }
  }

  return 'İşlem şu anda tamamlanamadı. Lütfen birkaç dakika içinde tekrar deneyin.';
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
