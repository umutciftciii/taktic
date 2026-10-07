'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  Category,
  CategoryStatus,
  IssuedProviderInvite,
  ProviderInviteRevokeResult,
  Question,
  QuestionConditionMatchMode,
  QuestionSystemField,
  QuestionType,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import type { ConfirmationProofKey } from '../../lib/confirmation-proof-keys';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../lib/confirmation-proof-keys';
import { hasConfirmationProof, hasConfirmationProofs } from '../../lib/confirmation-proof-server';
import {
  categoryChanges,
  categoryCreateNeedsProof,
  categoryPayload,
  categoryProofKeys,
  categoryStatusProofKey,
  readRouterRules,
  routerRuleChanges,
  type CategoryPayload,
  type CategoryStored,
} from './category-changes';
import type { ProviderInviteFormState } from './category-taxonomy';

const optionQuestionTypes = new Set<QuestionType>(['SELECT', 'MULTI_SELECT']);

export async function createCategoryAction(formData: FormData) {
  const payload = categoryPayload(formData);
  // Created straight into ACTIVE (the catalogue) or INACTIVE is a status
  // decision, asked in a dialog whose proof is checked before anything is sent
  // (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). A DRAFT goes straight through.
  if (categoryCreateNeedsProof(payload) && !(await hasConfirmationProof(formData, 'category.create-published'))) {
    redirect(`/categories/new?error=${CONFIRMATION_REQUIRED}`);
  }

  const category = await apiFetch<Category>('/categories', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  revalidatePath('/categories');
  redirect(`/categories/${category.slug}`);
}

export async function updateCategoryAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  // The edit form sends no slug (SEO-004 PR B): the address changes only in
  // the SEO slug window. One that arrives anyway is dropped, never sent.
  const payload = categoryPayload(formData);
  delete payload.slug;

  // What this save changes is judged against the category as the API has it
  // now, never on the form's word: a new type or parent, a new offer
  // price, the unlimited-package switch going on, or a status move each need
  // their own proof (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). A save of
  // the name, description, pictures or order needs none.
  const stored = await readStoredCategory(id);
  const required = stored ? categoryProofKeys(categoryChanges(stored, payload)) : everyEditProof(payload);
  if (required.length > 0 && !(await hasConfirmationProofs(formData, required))) {
    redirect(`${stored ? `/categories/${stored.slug}` : '/categories'}?error=${CONFIRMATION_REQUIRED}`);
  }

  const saved = await apiFetch<Category>(`/categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  // The address this save cannot have moved: the stored one, or — when it
  // could not be read — the one the API answered with.
  const slug = stored?.slug ?? saved.slug;
  revalidatePath('/categories');
  revalidatePath(`/categories/${slug}`);
  redirect(`/categories/${slug}`);
}

export async function updateCategoryStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const slug = readFormString(formData, 'slug');
  const status = readFormString(formData, 'status') as CategoryStatus;

  // Moving the status asks first, into ACTIVE or out of it; which way is
  // judged against the stored status. A press that leaves it where it is
  // writes the same status back and asks nothing.
  const stored = await readStoredCategory(id);
  if (!stored || stored.status !== status) {
    if (!(await hasConfirmationProof(formData, categoryStatusProofKey(status)))) {
      redirect(`/categories/${stored?.slug ?? slug}?error=${CONFIRMATION_REQUIRED}`);
    }
  }

  await apiFetch<Category>(`/categories/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

  revalidatePath('/categories');
  revalidatePath(`/categories/${slug}`);
}

/**
 * Replaces a question's visibility rules in one call.
 *
 * The rules on a question are ANDed together, so a half-saved set shows the
 * wrong questions to customers. The form posts the complete set every time and
 * the API replaces it; an empty set means "always visible".
 */
export async function replaceQuestionConditionsAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categorySlug = readFormString(formData, 'categorySlug');
  const sourceQuestionKey = readOptionalFormString(formData, 'sourceQuestionKey');

  /*
   * The expected answers arrive qualified as `<sourceKey>::<optionKey>`.
   *
   * The form offers every candidate source's options at once — grouped, and
   * without any script — so the whole rule can be set in one submission. That
   * only works if a value says which question it belongs to: two questions can
   * both offer `evet`, and a bare option key would be ambiguous. Entries for a
   * source other than the chosen one are the ones the reader did not mean, and
   * are dropped here.
   */
  const expectedValues = formData
    .getAll('expectedValues')
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => {
      const separator = value.indexOf('::');
      if (separator < 0) {
        return [];
      }

      const source = value.slice(0, separator);
      const optionKey = value.slice(separator + 2);

      return source === sourceQuestionKey && optionKey !== '' ? [optionKey] : [];
    });

  // Omitted or unrecognised means ANY, which is both the API default and what
  // every rule saved before this control existed means.
  const rawMode = readFormString(formData, 'matchMode');
  const matchMode: QuestionConditionMatchMode = rawMode === 'ALL' ? 'ALL' : 'ANY';

  await apiFetch<Question>(`/questions/${id}/conditions`, {
    method: 'PUT',
    body: JSON.stringify({
      conditions:
        sourceQuestionKey && expectedValues.length > 0
          ? [{ sourceQuestionKey, expectedValues, matchMode }]
          : [],
    }),
  });

  revalidatePath(`/categories/${categorySlug}`);
}

/**
 * Replaces a routing question's option → service map.
 *
 * One row per option, posted as parallel arrays so the browser can add and
 * remove rows without JavaScript. An option left without a destination is
 * dropped rather than saved as a route to nowhere.
 */
export async function replaceRouterRulesAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categorySlug = readFormString(formData, 'categorySlug');
  const posted = readRouterRules(formData);

  // A save that sends any customer somewhere else is confirmed in a dialog;
  // what changes is judged against the router's stored map, read from the API
  // (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). A question that cannot be
  // read is treated as changed. Saving the same map asks nothing.
  const stored = await readStoredRouterRules(categorySlug, id);
  if (stored === null || routerRuleChanges(stored, posted).length > 0) {
    if (!(await hasConfirmationProof(formData, 'category.router-rules-update'))) {
      redirect(`/categories/${categorySlug}?tab=sorular&error=${CONFIRMATION_REQUIRED}`);
    }
  }

  const rules = posted.flatMap((entry, index) =>
    entry.targetSlug === null
      ? []
      : [{ optionKey: entry.optionKey, targetCategorySlug: entry.targetSlug, sortOrder: index * 10 }],
  );

  await apiFetch<Question>(`/questions/${id}/router-rules`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  });

  revalidatePath(`/categories/${categorySlug}`);
}

export async function createQuestionAction(formData: FormData) {
  const categoryId = readFormString(formData, 'categoryId');
  const categorySlug = readFormString(formData, 'categorySlug');
  const payload = questionPayload(formData);

  await apiFetch(`/categories/${categoryId}/questions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  revalidatePath(`/categories/${categorySlug}`);
}

export async function updateQuestionAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categorySlug = readFormString(formData, 'categorySlug');
  const payload = questionPayload(formData);

  await apiFetch(`/questions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  revalidatePath(`/categories/${categorySlug}`);
}

export async function updateQuestionStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const categorySlug = readFormString(formData, 'categorySlug');
  const isActive = readFormString(formData, 'isActive') === 'true';

  // Deactivating takes the question out of every new request form; asked in a
  // dialog (Paket B). Activating goes straight through.
  if (!isActive && !(await hasConfirmationProof(formData, 'question.deactivate'))) {
    redirect(`/categories/${categorySlug}?tab=sorular&error=${CONFIRMATION_REQUIRED}`);
  }

  await apiFetch(`/questions/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath(`/categories/${categorySlug}`);
}

/**
 * Issuing and withdrawing an invitation, behind one action.
 *
 * One rather than two because the panel shows one result, and two independent
 * `useActionState` hooks cannot say which of them fired last: an issue would
 * keep its "here is the link" panel on screen while a later withdrawal
 * silently produced no message at all. Sharing the state makes the newest
 * outcome the only outcome — and it makes withdrawing an invitation clear the
 * link from the screen, which is exactly the right thing for it to do.
 *
 * `revalidatePath` refreshes the list and the readiness panel around it, but
 * the issued link is *not* part of that refreshed data and never could be — it
 * comes back in the returned state and lives only there.
 */
export async function providerInviteAction(
  _previous: ProviderInviteFormState,
  formData: FormData,
): Promise<ProviderInviteFormState> {
  const categoryId = readFormString(formData, 'categoryId');
  const categorySlug = readFormString(formData, 'categorySlug');
  const inviteId = readFormString(formData, 'inviteId');
  // Which button was pressed, read from the submitted form rather than from
  // which handler was bound — there is only one handler now.
  const revoking = readFormString(formData, 'intent') === 'revoke';

  // Withdrawing a link kills it for good; asked in a dialog (Paket B).
  // Issuing a new one goes straight through.
  if (revoking && !(await hasConfirmationProof(formData, 'provider-invite.revoke'))) {
    return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE };
  }

  try {
    if (revoking) {
      const result = await apiFetch<ProviderInviteRevokeResult>(
        `/categories/${categoryId}/provider-invites/${inviteId}/revoke`,
        { method: 'POST' },
      );

      revalidatePath('/categories');
      revalidatePath(`/categories/${categorySlug}`);

      // "Withdrawn" and "was already dead" are different sentences: the second
      // is what an operator sees when somebody applied through the link while
      // they were reaching for the button, and it has to read as a completed
      // request rather than as a silent no-op.
      return { kind: 'revoked', alreadyDead: !result.revoked };
    }

    const invite = await apiFetch<IssuedProviderInvite>(
      `/categories/${categoryId}/provider-invites`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    revalidatePath('/categories');
    revalidatePath(`/categories/${categorySlug}`);

    return { kind: 'issued', invite };
  } catch (error) {
    // A 401/403 from apiFetch is a redirect, not a failed invitation.
    rethrowNextControlFlow(error);
    return { kind: 'error', message: inviteFailureMessage(error) };
  }
}

/**
 * Turns a refusal into a sentence, without carrying the API's own text through.
 *
 * The only refusal an operator can provoke here on purpose is the category
 * one — a group, a router or a closed service — so that is the only one worth
 * explaining in its own words.
 */
function inviteFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.body.includes('PROVIDER_INVITE_CATEGORY_NOT_INVITABLE')) {
    return 'Yalnızca yayında veya taslak durumdaki hizmet kategorileri için davet bağlantısı üretilebilir.';
  }

  if (error instanceof ApiError && error.status === 404) {
    return 'Davet bağlantısı bulunamadı. Sayfayı yenileyin.';
  }

  return 'İşlem tamamlanamadı. Lütfen tekrar deneyin.';
}

/** The refusal code a submission without its confirmation proof comes back with. */
const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

/**
 * The category as the API has it now, found by id in the operator listing
 * (the detail route takes a slug, and the form's slug is the one being typed).
 * Null when it cannot be read.
 */
async function readStoredCategory(id: string): Promise<CategoryStored | null> {
  try {
    const categories = await apiFetch<Category[]>('/admin/categories');
    return categories.find((category) => category.id === id) ?? null;
  } catch (error) {
    rethrowNextControlFlow(error);
    return null;
  }
}

/**
 * The router question's stored option → service map, from the category the
 * form names — or null when it cannot be read or the question is not one of
 * that category's (a form naming another category's question is judged as a
 * change).
 */
async function readStoredRouterRules(
  categorySlug: string,
  questionId: string,
): Promise<Array<{ optionKey: string; targetCategorySlug: string }> | null> {
  try {
    const category = await apiFetch<Category & { questions?: Question[] }>(
      `/admin/categories/${encodeURIComponent(categorySlug)}`,
    );
    const question = category.questions?.find((candidate) => candidate.id === questionId);
    return question ? (question.routerRules ?? []) : null;
  } catch (error) {
    rethrowNextControlFlow(error);
    return null;
  }
}

/**
 * A category that cannot be read is treated as changing everything the save
 * could: refused unless every one of those is confirmed — which the screen,
 * judging against the category it rendered, never mints together.
 */
function everyEditProof(payload: CategoryPayload): ConfirmationProofKey[] {
  return [
    'category.structure-update',
    ...(payload.offerCreditCost !== undefined ? (['category.offer-credit-update'] as const) : []),
    ...(payload.unlimitedPackageEligible ? (['category.unlimited-enable'] as const) : []),
    ...(payload.status !== undefined ? [categoryStatusProofKey(payload.status)] : []),
  ];
}

function questionPayload(formData: FormData) {
  const type = readFormString(formData, 'type') as QuestionType;
  const systemField = readOptionalFormString(formData, 'systemField');

  return {
    key: readFormString(formData, 'key'),
    label: readFormString(formData, 'label'),
    helpText: readOptionalFormString(formData, 'helpText'),
    type,
    isRequired: readFormString(formData, 'isRequired') === 'true',
    // Empty means an ordinary question answered into the request's answers.
    systemField: (systemField as QuestionSystemField | null) ?? null,
    isRouter: readFormString(formData, 'isRouter') === 'true',
    sortOrder: readFormNumber(formData, 'sortOrder'),
    options: optionQuestionTypes.has(type) ? parseOptions(readOptionalFormString(formData, 'options')) : null,
    isActive: readFormString(formData, 'isActive') === 'true',
  };
}

function parseOptions(value: string | null) {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Options must be a JSON array');
  }

  return parsed;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}

function readFormNumber(formData: FormData, key: string) {
  const value = Number(readFormString(formData, key));
  return Number.isFinite(value) ? value : 0;
}
