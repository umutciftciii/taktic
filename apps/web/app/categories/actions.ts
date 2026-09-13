'use server';

import { redirect } from 'next/navigation';
import { apiFetch, RoutingResolution, ServiceRequest } from '../../lib/api';
import { describeApiRefusal } from '../../lib/api-refusal';
import {
  clearRequestDraftCookie,
  draftPayloadFromForm,
  saveRequestDraftAction,
  type SaveDraftResult,
} from '../../lib/request-drafts';
import { decodeRouterSelections, encodeRouterSelections } from '../../lib/request-flow';
import { buildServiceRequestPayload } from '../../lib/service-request-payload';

/**
 * One step of a routed flow.
 *
 * The browser posts the option the customer clicked; the API alone turns it
 * into a category and says where the flow stands. Nothing about the
 * destination is decided here — this action only forwards the answer and
 * navigates to whatever the API named, which may be another router.
 */
export async function resolveRouterStepAction(formData: FormData) {
  const entryCategorySlug = readFormString(formData, 'entryCategorySlug');
  const questionKey = readFormString(formData, 'routerQuestionKey');
  const optionKey = readFormString(formData, 'routerOptionKey');

  const selections = [
    ...decodeRouterSelections(readOptionalFormString(formData, 'routerSelections')),
    { questionKey, optionKey },
  ];

  const resolution = await apiFetch<RoutingResolution>('/categories/routing/resolve', {
    method: 'POST',
    body: JSON.stringify({ entryCategorySlug, selections }),
  });

  const query = new URLSearchParams({
    entry: resolution.entryCategorySlug,
    r: encodeRouterSelections(selections),
  });

  redirect(`/categories/${resolution.categorySlug}?${query.toString()}`);
}

export type SubmitRequestResult =
  | { ok: true; requestId: string }
  | { ok: false; code: string; message: string | null };

/**
 * Posts the request and answers the form rather than redirecting.
 *
 * The form is one screen that keeps everything the customer typed; a refusal
 * — a conflict on the contact fields, a DTO message — is shown inline beside
 * what caused it, and only the successful submission navigates (the component
 * does that, with the id returned here).
 */
export async function submitServiceRequestAction(formData: FormData): Promise<SubmitRequestResult> {
  try {
    // The body is built by the one function both request forms share — this
    // one and the vitrin card's — so the field names and the optional/required
    // split cannot drift between them.
    const request = await apiFetch<ServiceRequest>('/service-requests', {
      method: 'POST',
      body: JSON.stringify(buildServiceRequestPayload(formData)),
    });
    // The API consumed the draft inside the request's own transaction; only
    // the browser's cookie is left to clear.
    await clearRequestDraftCookie();
    return { ok: true, requestId: request.id };
  } catch (error) {
    return describeApiRefusal('service-requests', error);
  }
}

/**
 * Parks the marketplace form before the customer leaves it to sign in or to
 * activate an account. The contact fields are not part of the payload — they
 * are the identity the draft is bound to, and the account the customer comes
 * back with supplies them.
 */
export async function saveMarketplaceDraftAction(
  formData: FormData,
  replace: boolean,
): Promise<SaveDraftResult> {
  return saveRequestDraftAction({
    formType: 'MARKETPLACE',
    categorySlug: readFormString(formData, 'categorySlug'),
    payload: await draftPayloadFromForm(formData),
    identity: {
      phone: readFormString(formData, 'customerPhone'),
      email: readFormString(formData, 'customerEmail'),
    },
    replace,
  });
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
