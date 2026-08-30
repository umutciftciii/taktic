'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  Category,
  CategoryKind,
  CategoryStatus,
  IssuedProviderInvite,
  ProviderInviteRevokeResult,
  Question,
  QuestionConditionMatchMode,
  QuestionSystemField,
  QuestionType,
} from '../../lib/api';
import type { ProviderInviteFormState } from './category-taxonomy';

const optionQuestionTypes = new Set<QuestionType>(['SELECT', 'MULTI_SELECT']);

export async function createCategoryAction(formData: FormData) {
  const category = await apiFetch<Category>('/categories', {
    method: 'POST',
    body: JSON.stringify(categoryPayload(formData)),
  });

  revalidatePath('/categories');
  redirect(`/categories/${category.slug}`);
}

export async function updateCategoryAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const slug = readFormString(formData, 'slug');

  await apiFetch<Category>(`/categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(categoryPayload(formData)),
  });

  revalidatePath('/categories');
  revalidatePath(`/categories/${slug}`);
  redirect(`/categories/${slug}`);
}

export async function updateCategoryStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const slug = readFormString(formData, 'slug');
  const status = readFormString(formData, 'status') as CategoryStatus;

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
  const optionKeys = formData.getAll('routerOptionKey');
  const targets = formData.getAll('routerTargetSlug');

  const rules = optionKeys.flatMap((optionKey, index) => {
    const target = targets[index];

    if (typeof optionKey !== 'string' || typeof target !== 'string' || target.trim() === '') {
      return [];
    }

    return [{ optionKey, targetCategorySlug: target.trim(), sortOrder: index * 10 }];
  });

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

function categoryPayload(formData: FormData) {
  const kind = readFormString(formData, 'kind') as CategoryKind;
  const status = readFormString(formData, 'status') as CategoryStatus;

  return {
    name: readFormString(formData, 'name'),
    slug: readFormString(formData, 'slug'),
    description: readOptionalFormString(formData, 'description'),
    imageUrl: readOptionalFormString(formData, 'imageUrl'),
    coverImageUrl: readOptionalFormString(formData, 'coverImageUrl'),
    iconKey: readOptionalFormString(formData, 'iconKey'),
    // Empty means "top level"; the API refuses a parent that is not a GROUP.
    parentId: readOptionalFormString(formData, 'parentId'),
    kind,
    status,
    sortOrder: readFormNumber(formData, 'sortOrder'),
    // Mandatory for a service, and only for a service. A group is a folder and
    // a router is a question — neither can ever be offered on, so neither has a
    // price, and sending one would be a number nothing reads. Sent as a number
    // so the API DTO's @IsInt/@Min(1) rejects empty, zero, negative and
    // non-numeric input rather than the value silently becoming null.
    ...(kind === 'LEAF' ? { offerCreditCost: readFormNumber(formData, 'offerCreditCost') } : {}),
    // Only sent where the API will take it. A live service is always open to
    // applications and refuses the field, so sending it there would turn every
    // unrelated edit of a released category into a 400. `kind` and `status` come
    // off this same form, so the condition is asked of the category the save
    // produces — which is the row the API judges too.
    //
    // An unticked checkbox never reaches FormData at all, so the comparison
    // below is how closing the switch is expressed.
    ...(kind === 'LEAF' && status === 'DRAFT'
      ? { providerEnrollmentOpen: readFormString(formData, 'providerEnrollmentOpen') === 'on' }
      : {}),
  };
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
