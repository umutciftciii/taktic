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

export async function createShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const base = `/providers/${providerId}/vitrin`;

  let card: ShowcaseCard;
  try {
    card = await apiFetch<ShowcaseCard>(`/providers/${providerId}/showcase/cards`, {
      method: 'POST',
      body: JSON.stringify({
        kind: readString(formData, 'kind'),
        categoryId: readString(formData, 'categoryId'),
        ...contentPayload(formData),
      }),
    });
  } catch (error) {
    redirect(`${base}/yeni?error=${errorCode(error)}`);
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
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?saved=1`);
}

/**
 * Hands the open draft to an operator.
 *
 * The acceptance travels as its own two fields rather than being assumed: the
 * API refuses a submission that does not carry them, and a form that sent them
 * unconditionally would be accepting on the provider's behalf.
 */
export async function submitShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({
          priceTermsAccepted: formData.get('priceTermsAccepted') === 'on',
          priceTermsVersion: readString(formData, 'priceTermsVersion'),
        }),
      },
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

// ── Phase two: buying a run, and retiring a card ────────────────────────────

/**
 * Opens a checkout for one card and one package.
 *
 * Nothing about price, duration or coverage is sent. All three are read
 * server-side from the package and the card's live version, so this form cannot
 * decide what a placement costs or how far it reaches — see
 * `CreateShowcaseCheckoutDto`.
 *
 * Where the provider goes next depends on the adapter: a hosted checkout has a
 * URL and the browser is sent to it; the mock adapter has none, and the
 * purchase's own screen renders the in-app form. The action does not decide
 * which — it follows whatever the API said.
 */
export async function startShowcaseCheckoutAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const base = `/providers/${providerId}/vitrin/${cardId}`;

  let outcome: ShowcaseCheckoutResult;
  try {
    outcome = await apiFetch<ShowcaseCheckoutResult>(
      `/providers/${providerId}/showcase/placements/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({
          cardId,
          showcasePackageId: readString(formData, 'showcasePackageId'),
        }),
      },
    );
  } catch (error) {
    redirect(`${base}?error=${errorCode(error)}`);
  }

  revalidatePath(`/providers/${providerId}/vitrin`);

  if (outcome.checkout.url) {
    redirect(outcome.checkout.url);
  }

  // No hosted page: the purchase's own screen carries the clearly-labelled mock
  // form, exactly as it does for a credit package.
  redirect(`/providers/${providerId}/package-purchases/${outcome.purchase.id}`);
}

/**
 * Retires a card and takes its run off the air.
 *
 * The paid clock keeps running while it is archived, and the screen says so
 * before this is submitted — a provider who expected the time to pause would be
 * a provider surprised by a bill they had already paid.
 */
export async function archiveShowcaseCardAction(formData: FormData) {
  const providerId = readString(formData, 'providerId');
  const cardId = readString(formData, 'cardId');
  const target = `/providers/${providerId}/vitrin/${cardId}`;

  try {
    await apiFetch<ShowcaseCard>(
      `/providers/${providerId}/showcase/cards/${cardId}/archive`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  } catch (error) {
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  redirect(`${target}?archived=1`);
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
