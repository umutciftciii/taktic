'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, parseDecimalToMinor, ProviderOffer } from '../../../../../lib/api';

/** Pricing conflicts the API reports with a machine-readable code. */
type OfferConflict = {
  code?: string;
  expectedCreditCost?: number;
  actualCreditCost?: number;
};

export async function createOfferAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const requestId = readFormString(formData, 'requestId');

  // The form accepts a human-readable decimal (e.g. "1500,00" or "149.90").
  // parseDecimalToMinor converts it to the minor-unit integer (kuruş for TRY).
  // null is passed straight through; the API DTO enforces @Min(100) and surfaces
  // a clear validation error if the value is missing or below 1,00.
  const priceAmountMinor = parseDecimalToMinor(readFormString(formData, 'priceAmount'));

  try {
    await apiFetch<ProviderOffer>(`/providers/${providerId}/requests/${requestId}/offers`, {
      method: 'POST',
      body: JSON.stringify({
        priceAmount: priceAmountMinor,
        // The cost the page displayed. Compared for equality server-side; it
        // never determines what is charged.
        expectedCreditCost: readOptionalFormNumber(formData, 'expectedCreditCost'),
        currency: readOptionalFormString(formData, 'currency'),
        estimatedStartDate: readOptionalFormString(formData, 'estimatedStartDate'),
        estimatedCompletionDate: readOptionalFormString(formData, 'estimatedCompletionDate'),
        message: readFormString(formData, 'message'),
        warrantyNote: readOptionalFormString(formData, 'warrantyNote'),
        internalNote: readOptionalFormString(formData, 'internalNote'),
      }),
    });
  } catch (error) {
    // Pricing conflicts are expected outcomes, not crashes: they must land back
    // on the request screen with an explanation instead of the generic error
    // boundary. In every one of these cases the API created no offer and spent
    // no credit.
    const conflict = asOfferConflict(error);

    if (conflict?.code === 'CREDIT_COST_CHANGED') {
      const params = new URLSearchParams({ offerError: 'costChanged' });
      if (conflict.expectedCreditCost !== undefined) {
        params.set('shownCost', String(conflict.expectedCreditCost));
      }
      if (conflict.actualCreditCost !== undefined) {
        params.set('currentCost', String(conflict.actualCreditCost));
      }
      redirect(`/providers/${providerId}/requests/${requestId}?${params.toString()}`);
    }

    if (conflict?.code === 'CATEGORY_PRICE_UNSET') {
      redirect(`/providers/${providerId}/requests/${requestId}?offerError=priceUnset`);
    }

    if (conflict?.code === 'CATEGORY_INACTIVE') {
      redirect(`/providers/${providerId}/requests/${requestId}?offerError=categoryInactive`);
    }

    throw error;
  }

  revalidatePath(`/providers/${providerId}/requests/${requestId}`);
  revalidatePath(`/providers/${providerId}/offers`);
}

/**
 * Reports the request to the operators and lands back on the screen it was
 * opened from.
 *
 * Both refusals the API words for the provider — "already reported" (409) and
 * "daily limit" (429) — come back as a query flag the page turns into a
 * sentence, mirroring the `?offerError=` pattern above. Anything else is a
 * real failure and reaches the error boundary.
 *
 * `returnTo` is where the dialog lives — the request detail by default, or a
 * vitrin lead's own screen, which mounts the same dialog. Only a path inside
 * this provider's own panel is honoured; anything else falls back to the
 * request detail, so the field can never turn into an open redirect.
 */
export async function reportRequestAction(formData: FormData) {
  const providerId = readFormString(formData, 'providerId');
  const requestId = readFormString(formData, 'requestId');
  const base = `/providers/${providerId}/requests/${requestId}`;
  const returnTo = safeReturnPath(readOptionalFormString(formData, 'returnTo'), providerId) ?? base;

  try {
    await apiFetch(`${base}/reports`, {
      method: 'POST',
      body: JSON.stringify({
        reason: readFormString(formData, 'reason'),
        note: readOptionalFormString(formData, 'note'),
      }),
    });
  } catch (error) {
    const code = asOfferConflict(error)?.code ?? apiErrorCode(error);
    if (code === 'REPORT_ALREADY_EXISTS') redirect(`${returnTo}?reportError=exists`);
    if (code === 'REPORT_RATE_LIMITED') redirect(`${returnTo}?reportError=limit`);
    throw error;
  }

  revalidatePath(base);
  if (returnTo !== base) revalidatePath(returnTo);
  redirect(`${returnTo}?reported=1`);
}

/** A path in this provider's own panel, or null. Query and fragment are dropped. */
function safeReturnPath(value: string | null, providerId: string): string | null {
  if (!value) return null;
  const prefix = `/providers/${providerId}/`;
  if (!value.startsWith(prefix)) return null;
  return value.split(/[?#]/)[0] ?? null;
}

/** The machine-readable `code` from any ApiError body, whatever the status. */
function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.body) as { code?: unknown };
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

function asOfferConflict(error: unknown): OfferConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }

  try {
    const parsed = JSON.parse(error.body) as OfferConflict;
    return typeof parsed?.code === 'string' ? parsed : null;
  } catch {
    return null;
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

function readOptionalFormNumber(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
