'use server';

import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../lib/api';

/**
 * The three steps of writing to a business from its vitrin card.
 *
 * ## Why the telephone number is proved before the request exists
 *
 * Everywhere else in this product, a customer submits a request and proves
 * their number afterwards — the proof gates *moderation*, and an operator
 * stands between the customer and every business until then.
 *
 * This flow has no operator in the middle. The message reaches one business the
 * moment it is written and starts a clock that business is measured against. So
 * the proof comes first, and it is mandatory here whatever
 * `REQUIRE_PHONE_VERIFICATION` says — one of the two places in the product where
 * that flag is not the whole answer. The other reason compounds it: the request
 * has to become APPROVED for the business's own offer to land, and that
 * transition already refuses an unverified number, so opening the lead anyway
 * would start a clock on something that could never progress.
 *
 * The proof is single-use and short-lived. Nothing is stored here and no token
 * travels: the receipt is the consumed verification row itself, and the API
 * binds it to the request it creates.
 */

export async function startShowcaseLeadVerificationAction(formData: FormData) {
  const cardId = readString(formData, 'cardId');
  const phone = readString(formData, 'phone');
  const place = readLocation(formData);

  try {
    await apiFetch('/showcase/lead-verification', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  } catch (error) {
    redirect(`/vitrin/${cardId}?step=phone&error=${errorCode(error)}${place}`);
  }

  // The number travels in the query string so the next step's form can prefill
  // it. It is the visitor's own number, they just typed it, and it grants
  // nothing — the code is what proves anything, and that is never in a URL.
  redirect(`/vitrin/${cardId}?step=code&phone=${encodeURIComponent(phone)}${place}`);
}

export async function confirmShowcaseLeadVerificationAction(formData: FormData) {
  const cardId = readString(formData, 'cardId');
  const phone = readString(formData, 'phone');
  const code = readString(formData, 'code');
  const place = readLocation(formData);

  try {
    await apiFetch('/showcase/lead-verification/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  } catch (error) {
    redirect(
      `/vitrin/${cardId}?step=code&phone=${encodeURIComponent(phone)}&error=${errorCode(error)}${place}`,
    );
  }

  redirect(`/vitrin/${cardId}?step=form&phone=${encodeURIComponent(phone)}${place}`);
}

/**
 * Opens the lead.
 *
 * `urgencyBucket` is the customer's own choice between the two options the card
 * showed, and it is **not** the same field as `urgency`. The first is how long
 * they are willing to wait for a reply; the second is when they want the work
 * done, and a same-day job is very often one somebody is happy to be called
 * about tomorrow. Neither is derived from the other, here or in the API.
 *
 * What is deliberately not sent: the SLA hours (read from the card's approved
 * version), the placement id (resolved from the card on the server), and the
 * provider id. A body that could name any of the three would be a body deciding
 * whose run it attaches to and what deadline it sets.
 */
export async function createShowcaseLeadAction(formData: FormData) {
  const cardId = readString(formData, 'cardId');
  const phone = readString(formData, 'phone');

  try {
    await apiFetch(`/showcase/cards/${cardId}/leads`, {
      method: 'POST',
      body: JSON.stringify({
        categorySlug: readString(formData, 'categorySlug'),
        urgencyBucket: readString(formData, 'urgencyBucket'),
        customerName: readString(formData, 'customerName'),
        customerPhone: phone,
        customerEmail: readString(formData, 'customerEmail'),
        city: readString(formData, 'city'),
        district: readString(formData, 'district'),
        neighborhood: readOptional(formData, 'neighborhood'),
        description: readOptional(formData, 'description'),
        // The job's own timing, independent of the answer-time choice above.
        urgency: readOptional(formData, 'urgency'),
        answers: [],
        contactDisclosureAccepted: formData.get('contactDisclosureAccepted') === 'on',
      }),
    });
  } catch (error) {
    /*
     * The refusal travels as a code, and the address the customer typed travels
     * with it.
     *
     * `SHOWCASE_LEAD_AREA_NOT_SERVED` is the one the card page turns into a
     * route onward rather than a red box: the work is real, it is simply not
     * this business's, and the ordinary marketplace request is one click away.
     * Every other code re-renders the form with what they had entered, which is
     * why the location is carried here as well.
     */
    redirect(
      `/vitrin/${cardId}?step=form&phone=${encodeURIComponent(phone)}&error=${errorCode(error)}` +
        readLocation(formData),
    );
  }

  redirect(`/vitrin/${cardId}?sent=1`);
}

/**
 * The location the customer chose, as a query-string fragment.
 *
 * Carried from step to step purely so nobody is asked the same question twice —
 * and, on a refusal, so the form comes back with what they typed rather than
 * blank. It is never authority: the API re-resolves it against the shipped
 * location list and re-checks it against the run's own shelf on every
 * submission, so a hand-edited URL buys no lead a real form could not open.
 */
function readLocation(formData: FormData): string {
  const params = new URLSearchParams();
  for (const key of ['city', 'district', 'neighborhood'] as const) {
    const value = readString(formData, key);
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `&${query}` : '';
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptional(formData: FormData, key: string): string | null {
  const value = readString(formData, key);
  return value.length > 0 ? value : null;
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown };
      if (typeof parsed.code === 'string') {
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON with no code.
    }
  }

  return 'SHOWCASE_LEAD_FAILED';
}
