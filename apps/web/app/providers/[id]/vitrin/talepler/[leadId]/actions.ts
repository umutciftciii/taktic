'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch, parseDecimalToMinor } from '../../../../../../lib/api';

/**
 * Offering on a direct vitrin lead.
 *
 * Almost the same shape as `createOfferAction`, and deliberately **not** the
 * same function: this one sends no `expectedCreditCost`, because there is no
 * cost to agree on. The API resolves the payer before it charges anything, and
 * for a request reserved for this provider the answer is a paid placement and
 * zero credits. A form that carried a cost here would be a form asserting a
 * price for something that has none, and the equality check it exists for would
 * be comparing two numbers that both mean nothing.
 *
 * The endpoint is the ordinary offer endpoint. There is no vitrin-specific
 * offer route, and there must not be: an offer on a direct lead is an ordinary
 * offer that a different right paid for, and a second creation path would be a
 * second place for the one-offer-per-request guard, the category checks and the
 * refund policy to be got right.
 */
export async function createShowcaseLeadOfferAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const leadId = readString(formData, 'leadId');
  const requestId = readString(formData, 'requestId');
  const target = `/providers/${providerId}/vitrin/talepler/${leadId}`;

  try {
    await apiFetch(`/providers/${providerId}/requests/${requestId}/offers`, {
      method: 'POST',
      body: JSON.stringify({
        priceAmount: parseDecimalToMinor(readString(formData, 'priceAmount')),
        currency: readOptional(formData, 'currency'),
        estimatedStartDate: readOptional(formData, 'estimatedStartDate'),
        estimatedCompletionDate: readOptional(formData, 'estimatedCompletionDate'),
        message: readString(formData, 'message'),
        warrantyNote: readOptional(formData, 'warrantyNote'),
        internalNote: readOptional(formData, 'internalNote'),
      }),
    });
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  revalidatePath(`/providers/${providerId}/vitrin/talepler`);
  redirect(`${target}?offered=1`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptional(formData: FormData, key: string): string | null {
  const value = readString(formData, key);
  return value.length > 0 ? value : null;
}

/**
 * The API's machine code, never its message.
 *
 * A message is prose the API may reword, and a screen keying on prose breaks
 * silently when it does — the same reasoning the card form's actions already
 * use.
 */
function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown };
      if (typeof parsed.code === 'string') {
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON with no code. Falls through to the generic answer.
    }
  }

  return 'SHOWCASE_LEAD_OFFER_FAILED';
}
