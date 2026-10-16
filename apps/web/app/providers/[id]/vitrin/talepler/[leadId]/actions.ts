'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch } from '../../../../../../lib/api';
import { parseLiraToMinor } from '../../../../../../lib/lira-input';
import { validateOfferSchedule } from '@taktic/shared';

/**
 * Offering on a direct vitrin lead.
 *
 * Almost the same shape as `createOfferAction`, and deliberately **not** the
 * same function. Since CAMPAIGN-ENTITLEMENT-001 it sends the *effective* cost
 * the page previewed — 0 for one of the placement's free offers, the category
 * price after them — and the API compares it with what it resolves under its
 * own transaction. A mismatch (the last free slot went to another answer) is
 * a 409 CREDIT_COST_CHANGED that lands back here as a sentence, and a paid
 * answer the balance cannot cover is a 402 shown the same way.
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

  // REL-002 §6.1: the same schedule rules as the marketplace offer, checked
  // before anything is sent; the API checks again on its own clock and its
  // refusal comes back through `errorCode` below with the same code.
  const estimatedStartDate = readOptional(formData, 'estimatedStartDate');
  const estimatedCompletionDate = readOptional(formData, 'estimatedCompletionDate');
  const schedule = validateOfferSchedule(estimatedStartDate, estimatedCompletionDate);
  if (!schedule.ok) {
    redirect(`${target}?error=${schedule.code}`);
  }

  const expectedCreditCost = readOptionalNumber(formData, 'expectedCreditCost');

  try {
    await apiFetch(`/providers/${providerId}/requests/${requestId}/offers`, {
      method: 'POST',
      body: JSON.stringify({
        // The same lira field as the marketplace offer: grouped text in,
        // kuruş integer out, no floating point on the way.
        priceAmount: parseLiraToMinor(readString(formData, 'priceAmount')),
        // The cost the page showed. Compared for equality server-side; it
        // never decides what is charged.
        expectedCreditCost,
        currency: readOptional(formData, 'currency'),
        estimatedStartDate,
        estimatedCompletionDate,
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
  redirect(`${target}?offered=${expectedCreditCost === 0 ? 'free' : '1'}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumber(formData: FormData, key: string): number | null {
  const value = readString(formData, key);
  if (value.length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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
  // A paid answer the balance cannot cover: the API's 402 carries no code.
  if (error instanceof ApiError && error.status === 402) {
    return 'INSUFFICIENT_CREDIT';
  }
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown; allowanceVoided?: unknown };
      // SHOWCASE-ALLOWANCE-004: the same 409, but the free offers were
      // cancelled by the platform rather than spent — a different sentence.
      if (parsed.code === 'CREDIT_COST_CHANGED' && parsed.allowanceVoided === true) {
        return 'CREDIT_COST_CHANGED_ALLOWANCE_VOID';
      }
      if (typeof parsed.code === 'string') {
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON with no code. Falls through to the generic answer.
    }
  }

  return 'SHOWCASE_LEAD_OFFER_FAILED';
}
