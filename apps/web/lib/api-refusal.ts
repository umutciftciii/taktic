import { ApiError } from './api';
import { REQUEST_REFUSAL_GENERIC } from './request-refusal-text';

/**
 * A request the API refused, as the form shows it and the log keeps it.
 *
 * Shared by the marketplace form's action and the vitrin card's, because both
 * post the same body to the same kind of endpoint and both used to translate a
 * refusal by hand — and the first time the two drifted, one of them folded a
 * DTO validation message into the generic code, which is how a free-text
 * district became "Talebiniz gönderilemedi" with nothing in any log to say why.
 */
export type ApiRefusal = {
  ok: false;
  /** The API's own code when it gave one, or the generic one. */
  code: string;
  /**
   * What the API said, for the refusals it words for the customer — a
   * validation message, a conflict. Null when there was nothing safe to show,
   * and the form falls back to its own sentence for the code.
   */
  message: string | null;
  /**
   * Which field the refusal is about, when the API named one — today only
   * `CONTACT_DETAILS_IN_TEXT` does (`description`, `addressNote`,
   * `answers.<questionKey>`). The form uses it to put the sentence under the
   * field rather than above the steps.
   */
  field?: string;
  /** What was found there: `phone`, `email` or `url`. Same source as `field`. */
  kind?: string;
};

/**
 * Turns an API refusal into an {@link ApiRefusal}.
 *
 * The API answers two ways. Its own refusals carry a `code` and a sentence
 * written for the customer (`SHOWCASE_LEAD_AREA_NOT_SERVED`, …). A body the DTO
 * refuses carries no code, only class-validator's messages. A 4xx message
 * reaches the customer; status, code and message reach the server log. Neither
 * carries what the customer typed.
 *
 * `step` names the call — `service-requests`, `vitrin/cards/<id>/leads` — so
 * a refusal can be found in the log without the body, and so the one
 * code-less refusal below can be worded for the form it happened on.
 */
export function describeApiRefusal(step: string, error: unknown): ApiRefusal {
  if (!(error instanceof ApiError)) {
    console.error(`[request] ${step}: unexpected failure`, error);
    return { ok: false, code: REQUEST_REFUSAL_GENERIC, message: null };
  }

  let code: string | null = null;
  let message: string | null = null;
  let field: string | null = null;
  let kind: string | null = null;

  try {
    const parsed = JSON.parse(error.body) as {
      code?: unknown;
      message?: unknown;
      field?: unknown;
      kind?: unknown;
    };
    if (typeof parsed.code === 'string') {
      code = parsed.code;
    }
    if (typeof parsed.field === 'string') {
      field = parsed.field;
    }
    if (typeof parsed.kind === 'string') {
      kind = parsed.kind;
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
    `[request] ${step}: API refused with ${error.status}` +
      ` code=${code ?? '-'} message=${JSON.stringify(message ?? '-')}`,
  );

  // Only a refusal the API worded for the client is shown as-is; a 5xx body is
  // not a sentence for a customer.
  const userFacing = error.status >= 400 && error.status < 500;

  // The one refusal that carries no code but has a fixed meaning here: a
  // PROVIDER session may not open a customer request. Named so the form can
  // say so in Turkish rather than relay the API's English sentence — and named
  // per form, because the sentence names what could not be sent: a vitrin
  // lead on the card's form, a request on the marketplace form.
  if (!code && error.status === 403) {
    return { ok: false, code: step === 'service-requests' ? 'REQUEST_FORBIDDEN' : 'SHOWCASE_LEAD_FORBIDDEN', message: null };
  }

  return {
    ok: false,
    code: code ?? REQUEST_REFUSAL_GENERIC,
    message: userFacing ? message : null,
    // Only when the API named them, so the shape of every other refusal is
    // unchanged.
    ...(field && userFacing ? { field } : {}),
    ...(kind && userFacing ? { kind } : {}),
  };
}
