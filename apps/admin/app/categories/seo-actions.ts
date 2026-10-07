'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch } from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import { readSeoRefusal, seoRefusalMessage, type FaqItem } from '../../lib/seo';
import type { CategorySeoState } from './seo-content-state';

/**
 * Saves a category's search-engine content (SEO-004 PR B) through the API's
 * own route, `PATCH /admin/seo/categories/:id/content` (SEO_CONTENT_WRITE).
 * Every field is sent as typed and judged there (`category-seo-content.ts`);
 * an empty field goes as null ("not written"), an empty FAQ as null.
 */
export async function updateCategorySeoContentAction(
  _previous: CategorySeoState,
  formData: FormData,
): Promise<CategorySeoState> {
  const categoryId = readString(formData, 'categoryId');
  const categorySlug = readString(formData, 'categorySlug');
  const faq = readFaq(formData);
  if (!categoryId || faq === 'invalid') {
    return { kind: 'error', message: 'Form okunamadı; sayfayı yenileyip yeniden deneyin.', field: null, at: Date.now() };
  }

  try {
    await apiFetch(`/admin/seo/categories/${encodeURIComponent(categoryId)}/content`, {
      method: 'PATCH',
      body: JSON.stringify({
        seoTitle: nullable(formData, 'seoTitle'),
        seoDescription: nullable(formData, 'seoDescription'),
        editorialDecisionGuide: nullable(formData, 'editorialDecisionGuide'),
        editorialPriceFactors: nullable(formData, 'editorialPriceFactors'),
        editorialFaq: faq.length === 0 ? null : faq,
      }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    const body = error instanceof ApiError ? readSeoRefusal(error.body) : null;
    return {
      kind: 'error',
      message: seoRefusalMessage(body, error instanceof ApiError ? error.status : undefined),
      field: typeof body?.field === 'string' ? body.field : null,
      at: Date.now(),
    };
  }

  revalidatePath(`/categories/${categorySlug}`);
  revalidatePath('/seo');
  revalidatePath('/seo/indexing');
  return { kind: 'saved', at: Date.now() };
}

function readString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function nullable(formData: FormData, name: string): string | null {
  const value = readString(formData, name).trim();
  return value === '' ? null : value;
}

/** The FAQ rows; fully empty rows are dropped, a half row goes to the API to be named. */
function readFaq(formData: FormData): FaqItem[] | 'invalid' {
  try {
    const parsed = JSON.parse(readString(formData, 'editorialFaq') || '[]') as unknown;
    if (!Array.isArray(parsed)) return 'invalid';
    const rows: FaqItem[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return 'invalid';
      const { question, answer } = item as Record<string, unknown>;
      if (typeof question !== 'string' || typeof answer !== 'string') return 'invalid';
      if (!question.trim() && !answer.trim()) continue;
      rows.push({ question, answer });
    }
    return rows;
  } catch {
    return 'invalid';
  }
}
