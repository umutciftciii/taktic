'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch, type ShowcaseCard } from '../../../../lib/api';
import { parseLiraToMinor } from '../../../../lib/lira-input';
import { readServiceAreas } from '../../../../lib/service-area-payload';

/**
 * The vitrin form's server actions.
 *
 * Every one of them is a thin translation from a `FormData` to the API's JSON
 * body and back. Nothing here decides anything: not whether a price is allowed,
 * not whether an area is inside the provider's coverage, and not whether an edit
 * needs review. The API owns all three, because the API is what a request that
 * never went through this form also has to satisfy.
 *
 * A refusal is put back on the screen as `?error=<code>`, and the page maps the
 * code onto a sentence. The code travels rather than the message so a copy edit
 * on either side is not a functional change — the same reason the offer flow
 * carries codes.
 */

/**
 * Opens a card against a bought right.
 *
 * `entitlementId` travels only when the screen let the provider pick one; left
 * out, the API binds the oldest usable right itself. A refusal about the right
 * — none on hand, the wrong kind — lands on the list, because buying a package
 * is the answer and the list is where that button is. Every other refusal is
 * about the content, and goes back to the form that can show it.
 */
/** The refusals a package purchase answers; the list screen renders these. */
const ENTITLEMENT_REFUSALS = new Set([
  'SHOWCASE_ENTITLEMENT_REQUIRED',
  'SHOWCASE_ENTITLEMENT_UNAVAILABLE',
  'SHOWCASE_ENTITLEMENT_KIND_MISMATCH',
]);

export async function createShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const base = `/providers/${providerId}/vitrin`;
  const entitlementId = readOptionalString(formData, 'entitlementId');

  let card: ShowcaseCard;
  try {
    card = await apiFetch<ShowcaseCard>(`/providers/${providerId}/showcase/cards`, {
      method: 'POST',
      body: JSON.stringify({
        kind: readString(formData, 'kind'),
        categoryId: readString(formData, 'categoryId'),
        ...(entitlementId ? { entitlementId } : {}),
        ...contentPayload(formData),
      }),
    });
  } catch (error) {
    const code = errorCode(error);
    redirect(ENTITLEMENT_REFUSALS.has(code) ? `${base}?error=${code}` : `${base}/yeni?error=${code}`);
  }

  revalidatePath(base);
  redirect(`${base}/${card.id}`);
}

export async function updateShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(`/providers/${providerId}/showcase/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify(contentPayload(formData)),
    });
  } catch (error) {
    // Back to the form that can show it, not to the summary screen.
    redirect(`${target}/duzenle?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?saved=1`);
}

/**
 * Hands the open draft to an operator.
 *
 * An empty body, and the API refuses any other: the sale terms were accepted
 * when the package was bought, so there is nothing for this form to assert on
 * the provider's behalf.
 */
export async function submitShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/submit`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?submitted=1`);
}

/**
 * Takes the submission back out of the review queue.
 *
 * No payload beyond the two ids, and deliberately so: which version is in play
 * is whatever the card's own draft pointer names, decided by the API. A form
 * field naming a version would be a form field naming somebody else's.
 */
export async function withdrawShowcaseSubmissionAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/withdraw-submission`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?withdrawn=1`);
}

/**
 * The card content every write shares.
 *
 * The price is sent only for a SERVICE card, and as `null` for a PROMOTION one.
 * Sending it either way round would be the client asserting something about the
 * kind; the API refuses the wrong combination and the database refuses it again.
 */
function contentPayload(formData: FormData) {
  const kind = formData.get('kind');
  const priceMinor =
    kind === 'PROMOTION' ? null : parseLiraToMinor(readString(formData, 'listedServicePrice'));

  return {
    title: readString(formData, 'title'),
    summary: readString(formData, 'summary'),
    scopeIncluded: readLines(formData, 'scopeIncluded'),
    scopeExcluded: readLines(formData, 'scopeExcluded'),
    listedServicePriceAmount: priceMinor,
    imageUrl: readOptionalString(formData, 'imageUrl'),
    responseSlaUrgentHours: readInt(formData, 'responseSlaUrgentHours', 3),
    responseSlaNormalHours: readInt(formData, 'responseSlaNormalHours', 24),
    // The same helper the profile form uses, reading the same `serviceAreas`
    // entries the same picker writes. One reader, so the two forms cannot
    // disagree about what an area is.
    areas: readServiceAreas(formData),
  };
}

/**
 * One textarea line per item, blanks dropped.
 *
 * A trailing newline is what a person leaves behind, not an empty item, and
 * sending it would be an empty scope bullet on a card somebody has to approve.
 */
function readLines(formData: FormData, key: string): string[] {
  return readString(formData, key)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(formData: FormData, key: string): string | null {
  const value = readString(formData, key);
  return value.length > 0 ? value : null;
}

function readInt(formData: FormData, key: string, fallback: number): number {
  const parsed = Number.parseInt(readString(formData, key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The API's own machine code for a refusal, or a generic one.
 *
 * Never the message: a message is prose the API may reword, and a screen keying
 * on prose breaks silently when it does.
 */
function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown };
      if (typeof parsed.code === 'string') {
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON without a code. Falls through to the generic answer.
    }
  }

  return 'SHOWCASE_SAVE_FAILED';
}

// ── Buying a right, binding it, and retiring a card ──────────────────────

/**
 * Buys a package. The acceptance travels only when the screen asked for it —
 * the API already knows whether this business agreed to the version in force
 * and refuses a purchase without it.
 */
export async function startShowcasePackageCheckoutAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const returnCard = readOptionalString(formData, 'returnCard');
  const base = `/providers/${providerId}/vitrin/paketler${returnCard ? `?card=${encodeURIComponent(returnCard)}` : ''}`;
  const priceTermsVersion = readOptionalString(formData, 'priceTermsVersion');

  let outcome: ShowcaseCheckoutResult;
  try {
    outcome = await apiFetch<ShowcaseCheckoutResult>(`/providers/${providerId}/showcase/packages/checkout`, {
      method: 'POST',
      body: JSON.stringify({
        showcasePackageId: readString(formData, 'showcasePackageId'),
        ...(priceTermsVersion
          ? { priceTermsVersion, priceTermsAccepted: formData.get('priceTermsAccepted') === 'on' }
          : {}),
      }),
    });
  } catch (error) {
    redirect(`${base}${base.includes('?') ? '&' : '?'}error=${errorCode(error)}`);
  }

  revalidatePath(`/providers/${providerId}/vitrin`);

  if (outcome.checkout.url) {
    redirect(outcome.checkout.url);
  }
  // No hosted page (mock provider): the in-app form, which returns to the vitrin payment screen.
  redirect(`/providers/${providerId}/package-purchases/${outcome.purchase.id}/checkout?return=vitrin${returnCard ? `&card=${encodeURIComponent(returnCard)}` : ''}`);
}

/** Binds a right to a card that has none; the API publishes at once if the card is already approved. */
export async function useShowcaseEntitlementAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;
  try {
    await apiFetch<ShowcaseCard>(`/providers/${providerId}/showcase/cards/${cardId}/use-entitlement`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }
  revalidatePath(`/providers/${providerId}/vitrin`);
  revalidatePath(target);
  redirect(`${target}?published=1`);
}

/**
 * Retires a card and takes its run off the air.
 *
 * The paid clock keeps running while it is archived, and the screen says so
 * before this is submitted — a provider who expected the time to pause would be
 * a provider surprised by a bill they had already paid.
 *
 * A card that never went live is a different case: the API releases its right
 * back to the pool, and the screen calls that "deleting" the card. The form
 * says which it meant with `deleted=1`, and the provider lands on the list —
 * there is nothing on the card's own screen left to look at.
 */
export async function archiveShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;
  const deleted = formData.get('deleted') === '1';

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/archive`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(`/providers/${providerId}/vitrin`);
  revalidatePath(target);
  redirect(deleted ? `/providers/${providerId}/vitrin?deleted=1` : `${target}?archived=1`);
}

export async function unarchiveShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/unarchive`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?unarchived=1`);
}

type ShowcaseCheckoutResult = {
  purchase: { id: string };
  checkout: { url: string | null; reused: boolean };
};
