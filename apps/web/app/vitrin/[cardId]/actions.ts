'use server';

import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../lib/api';
import { buildServiceRequestPayload, readFormString } from '../../../lib/service-request-payload';

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

/**
 * The code every refusal without a more specific one is reported under. Not
 * exported: a 'use server' module may only export async functions, so the
 * component spells the same string in its own error table.
 */
const SHOWCASE_LEAD_FAILED = 'SHOWCASE_LEAD_FAILED';

export async function startShowcaseLeadVerificationAction(
  phone: string,
): Promise<LeadActionResult> {
  try {
    await apiFetch('/showcase/lead-verification', {
      method: 'POST',
      body: JSON.stringify({ phone: phone.trim() }),
    });
  } catch (error) {
    return describeFailure('lead-verification', error);
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
    return describeFailure('lead-verification/verify', error);
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
export async function createShowcaseLeadAction(formData: FormData): Promise<LeadActionResult> {
  const cardId = readFormString(formData, 'cardId');

  try {
    await apiFetch(`/showcase/cards/${encodeURIComponent(cardId)}/leads`, {
      method: 'POST',
      body: JSON.stringify({
        ...buildServiceRequestPayload(formData),
        urgencyBucket: readFormString(formData, 'urgencyBucket'),
      }),
    });
  } catch (error) {
    return describeFailure(`cards/${cardId}/leads`, error);
  }

  redirect(`/vitrin/${encodeURIComponent(cardId)}?sent=1`);
}

/**
 * Turns an API refusal into what the component shows and what the log keeps.
 *
 * The API answers two ways. Its own refusals carry a `code` and a sentence
 * written for the customer (`SHOWCASE_LEAD_AREA_NOT_SERVED`, …). A body the DTO
 * refuses carries no code, only class-validator's messages — and the old flow
 * folded those into the generic code, which is how a free-text district became
 * "Talebiniz gönderilemedi" with nothing in any log to say why. Now a 4xx
 * message reaches the customer, and status, code and message reach the server
 * log. Neither carries what the customer typed.
 */
function describeFailure(step: string, error: unknown): LeadActionResult {
  if (!(error instanceof ApiError)) {
    console.error(`[vitrin lead] ${step}: unexpected failure`, error);
    return { ok: false, code: SHOWCASE_LEAD_FAILED, message: null };
  }

  let code: string | null = null;
  let message: string | null = null;

  try {
    const parsed = JSON.parse(error.body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === 'string') {
      code = parsed.code;
    }
    // Nest's own exceptions carry a string; the ValidationPipe carries a list.
    const raw = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
    if (typeof raw === 'string' && raw.trim()) {
      message = raw.trim();
    }
  } catch {
    // Not JSON, or JSON with neither.
  }

  console.error(
    `[vitrin lead] ${step}: API refused with ${error.status}` +
      ` code=${code ?? '-'} message=${JSON.stringify(message ?? '-')}`,
  );

  // Only a refusal the API worded for the client is shown as-is; a 5xx body is
  // not a sentence for a customer.
  const userFacing = error.status >= 400 && error.status < 500;

  // The one refusal that carries no code but has a fixed meaning here: a
  // PROVIDER session cannot open a lead. Named so the form can say so in
  // Turkish rather than relay the API's English sentence.
  if (!code && error.status === 403) {
    return { ok: false, code: 'SHOWCASE_LEAD_FORBIDDEN', message: null };
  }

  return { ok: false, code: code ?? SHOWCASE_LEAD_FAILED, message: userFacing ? message : null };
}
