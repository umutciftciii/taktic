'use server';

import { redirect } from 'next/navigation';
import { apiFetch } from '../../../lib/api';
import { describeApiRefusal } from '../../../lib/api-refusal';
import { draftConsumedBySubmission, readDraftState } from '../../../lib/draft-state';
import {
  clearRequestDraftCookie,
  draftPayloadFromForm,
  saveRequestDraftAction,
  type SaveDraftResult,
} from '../../../lib/request-drafts';
import { buildServiceRequestPayload, readFormString } from '../../../lib/service-request-payload';
import { turnstileHeaders } from '../../../lib/turnstile';

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
 *
 * ## Why these return a result instead of redirecting
 *
 * The form is one screen that keeps everything the customer typed while the
 * number is proved inside it. A redirect on every step would throw that away
 * — the old flow carried the location in the query string and lost the rest —
 * so each step answers the component that called it, and only the successful
 * submission navigates.
 */

export type LeadActionResult =
  | { ok: true }
  | {
      ok: false;
      /** The API's own code when it gave one, or the generic one. */
      code: string;
      /**
       * What the API said, for the refusals it words for the customer — a
       * validation message, a conflict. Null when there was nothing safe to
       * show, and the component falls back to its own sentence for the code.
       */
      message: string | null;
    };

export async function startShowcaseLeadVerificationAction(
  phone: string,
  turnstileToken: string | null,
): Promise<LeadActionResult> {
  try {
    await apiFetch('/showcase/lead-verification', {
      method: 'POST',
      // The send costs an SMS, so it carries the Turnstile token; the confirm
      // below spends nothing and carries none.
      headers: turnstileHeaders(turnstileToken),
      body: JSON.stringify({ phone: phone.trim() }),
    });
  } catch (error) {
    return describeApiRefusal('vitrin/lead-verification', error);
  }

  return { ok: true };
}

export async function confirmShowcaseLeadVerificationAction(
  phone: string,
  code: string,
): Promise<LeadActionResult> {
  try {
    await apiFetch('/showcase/lead-verification/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
    });
  } catch (error) {
    return describeApiRefusal('vitrin/lead-verification/verify', error);
  }

  return { ok: true };
}

/**
 * Opens the lead.
 *
 * The body is the marketplace request body — built by the same function the
 * category form posts through, so the location, timing, contact and answer
 * fields cannot drift from what the API's DTO reads — plus `urgencyBucket`.
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
export async function createShowcaseLeadAction(
  formData: FormData,
  turnstileToken: string | null,
): Promise<LeadActionResult> {
  const cardId = readFormString(formData, 'cardId');

  try {
    await apiFetch(`/showcase/cards/${encodeURIComponent(cardId)}/leads`, {
      method: 'POST',
      // A second argument rather than a form field: the FormData is also what
      // the draft is built from, and a token is never parked. See the
      // marketplace action for the same rule.
      headers: turnstileHeaders(turnstileToken),
      body: JSON.stringify({
        ...buildServiceRequestPayload(formData),
        urgencyBucket: readFormString(formData, 'urgencyBucket'),
      }),
    });
  } catch (error) {
    return describeApiRefusal(`vitrin/cards/${cardId}/leads`, error);
  }

  // The API consumed the draft inside the lead's own transaction — when the
  // draft was this form's to consume — and the cookie goes before the redirect
  // so the card page the customer lands on does not read a token for a row
  // that is gone. A draft protected for another account (`wrong-account`), or
  // one this form never opened, was left alone by the API and keeps its
  // cookie for the account it belongs to; see lib/draft-state.ts.
  if (draftConsumedBySubmission(readDraftState(formData))) {
    await clearRequestDraftCookie();
  }
  redirect(`/vitrin/${encodeURIComponent(cardId)}?sent=1`);
}

/**
 * Parks the vitrin form before the customer leaves it to sign in or to
 * activate an account. Keyed by the card as well as the category, so a draft
 * for one business is never restored into another's form. The contact fields
 * are not part of the payload — they are the identity the draft is bound to,
 * and the account the customer comes back with supplies them.
 */
export async function saveShowcaseDraftAction(
  formData: FormData,
  replace: boolean,
): Promise<SaveDraftResult> {
  return saveRequestDraftAction({
    formType: 'SHOWCASE_LEAD',
    categorySlug: readFormString(formData, 'categorySlug'),
    cardId: readFormString(formData, 'cardId'),
    payload: await draftPayloadFromForm(formData),
    identity: {
      phone: readFormString(formData, 'customerPhone'),
      email: readFormString(formData, 'customerEmail'),
    },
    replace,
  });
}
