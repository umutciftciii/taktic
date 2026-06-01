'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, Category, QuestionType } from '../../lib/api';

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
  const isActive = readFormString(formData, 'isActive') === 'true';

  await apiFetch<Category>(`/categories/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

  revalidatePath('/categories');
  revalidatePath(`/categories/${slug}`);
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

function categoryPayload(formData: FormData) {
  return {
    name: readFormString(formData, 'name'),
    slug: readFormString(formData, 'slug'),
    description: readOptionalFormString(formData, 'description'),
    imageUrl: readOptionalFormString(formData, 'imageUrl'),
    coverImageUrl: readOptionalFormString(formData, 'coverImageUrl'),
    iconKey: readOptionalFormString(formData, 'iconKey'),
    sortOrder: readFormNumber(formData, 'sortOrder'),
    isActive: readFormString(formData, 'isActive') === 'true',
  };
}

function questionPayload(formData: FormData) {
  const type = readFormString(formData, 'type') as QuestionType;

  return {
    key: readFormString(formData, 'key'),
    label: readFormString(formData, 'label'),
    helpText: readOptionalFormString(formData, 'helpText'),
    type,
    isRequired: readFormString(formData, 'isRequired') === 'true',
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
