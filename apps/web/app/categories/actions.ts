'use server';

import { redirect } from 'next/navigation';
import { apiFetch, getCurrentUser, RoutingResolution, ServiceRequest, type ShowcaseFeed } from '../../lib/api';
import { describeApiRefusal, type ApiRefusal } from '../../lib/api-refusal';
import { draftConsumedBySubmission, readDraftState } from '../../lib/draft-state';
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
  | {
      ok: true;
      requestId: string;
      /**
       * The request's status as the API created it: `APPROVED` when it was
       * born live and is already in front of providers, `SUBMITTED` when an
       * operator reads it first. The success page words itself on this.
       */
      status: string;
    }
  | ApiRefusal;

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
    // The API consumed the draft inside the request's own transaction — when
    // the draft was this form's to consume. A draft protected for another
    // account (`wrong-account`), or one this form never opened, was left
    // alone by the API, and its cookie is kept for the account it belongs to;
    // see lib/draft-state.ts.
    if (draftConsumedBySubmission(readDraftState(formData))) {
      await clearRequestDraftCookie();
    }
    return { ok: true, requestId: request.id, status: request.status };
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

export type HandOffResult =
  | { ok: true; href: string }
  | {
      ok: false;
      code:
        | 'CARD_UNAVAILABLE'
        | 'IDENTITY_MISSING'
        | 'DRAFT_EXISTS'
        | 'DRAFT_NOT_CONTINUABLE'
        | 'DRAFT_BUSY'
        | 'DRAFT_FAILED';
    };

/**
 * Hands a half-written marketplace request over to one business's vitrin form.
 *
 * ## What travels, and how
 *
 * Everything the customer typed that the vitrin form can hold — description,
 * category answers, the location triple, the address note, the date range,
 * the budget, the urgency — is parked as a `RequestDraft` keyed on the card
 * (`SHOWCASE_LEAD` + the card's category + the card id), which is exactly the
 * draft that form already restores on load. The browser is handed nothing but
 * the opaque draft token in its HttpOnly cookie and a URL that names the card:
 * no field value and no personal detail ever enters the address bar.
 *
 * The contact fields are deliberately *not* in the draft — the draft payload
 * refuses them by contract. A visitor types their number again on the card's
 * form, because that form has to verify it anyway; a signed-in customer's
 * contact comes from the account there as it does here.
 *
 * ## What is checked before anything is saved
 *
 * The card is re-read from the feed for this category and this place. A card
 * that has come off the air, or whose run no longer covers the district, is
 * refused *here*, with nothing written: the customer keeps every field on
 * screen and the form falls back to the general request. The vitrin page and
 * the lead endpoint check again for themselves — this is a courtesy, not the
 * rule.
 *
 * ## What is not done
 *
 * No `ServiceRequest`, no `ShowcaseLead`, no message of any kind. Those are
 * the vitrin form's to create, under its own rules — the mandatory telephone
 * verification and the customer's acil/normal choice — when the customer
 * sends it from there.
 */
export async function handOffToShowcaseAction(
  formData: FormData,
  target: { cardId: string; categoryId: string },
): Promise<HandOffResult> {
  const city = readFormString(formData, 'city').trim();
  const district = readFormString(formData, 'district').trim();
  const neighborhood = readFormString(formData, 'neighborhood').trim();

  let card: ShowcaseFeed['cards'][number] | undefined;
  try {
    const params = new URLSearchParams({ categoryId: target.categoryId, city, district });
    if (neighborhood) params.set('neighborhood', neighborhood);
    const feed = await apiFetch<ShowcaseFeed>(`/showcase/feed?${params.toString()}`);
    card = feed.cards.find((entry) => entry.cardId === target.cardId);
  } catch {
    card = undefined;
  }
  if (!card) {
    return { ok: false, code: 'CARD_UNAVAILABLE' };
  }

  // The identity the draft is bound to. A visitor's is what they typed on the
  // contact step; a signed-in customer's is the account's, so only that
  // account can open the draft on the card's page.
  const user = await getCurrentUser();
  const identity =
    user?.role === 'CUSTOMER'
      ? { phone: user.phone ?? '', email: user.email ?? '' }
      : {
          phone: readFormString(formData, 'customerPhone').trim(),
          email: readFormString(formData, 'customerEmail').trim(),
        };
  if (!identity.phone || !identity.email) {
    return { ok: false, code: 'IDENTITY_MISSING' };
  }

  const saved = await saveRequestDraftAction({
    formType: 'SHOWCASE_LEAD',
    categorySlug: card.category.slug,
    cardId: card.cardId,
    payload: await draftPayloadFromForm(formData),
    identity,
    replace: formData.get('replaceDraft') === 'true',
  });
  if (!saved.ok) {
    return { ok: false, code: saved.code };
  }

  // Straight onto the card's form (`step=form` is the page's own switch, not
  // data); the draft the form restores travels in the cookie, never here.
  return { ok: true, href: `/vitrin/${encodeURIComponent(card.cardId)}?step=form` };
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}
