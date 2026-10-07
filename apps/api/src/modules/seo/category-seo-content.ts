import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * SEO-004 — a category's SEO content, as an operator writes it.
 *
 *   seoTitle                ≤ 70   the page's <title> text; NULL → category name
 *   seoDescription          ≤ 160  the meta description; NULL → the old fallback
 *   editorialDecisionGuide  ≤ 6000 "Nasıl seçilir" — an index-rule block
 *   editorialPriceFactors   ≤ 6000 "Fiyatı neler etkiler" — an index-rule block
 *   editorialFaq            1–20 × { question ≤ 200, answer ≤ 2000 } — the third block
 *
 * Everything is plain text: the web renders it as text, never as HTML, so a
 * `<` is a less-than sign. Each field is trimmed, line endings become `\n`,
 * and an empty value is NULL ("not written"). Control characters other than a
 * newline or a tab are refused rather than stripped — an invisible character
 * in a title is a paste accident somebody should see. The limits are the
 * migration's CHECKs, restated so the operator gets a 400 naming the field
 * instead of a 500 from the database.
 */

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;
export const EDITORIAL_BLOCK_MAX = 6000;
export const FAQ_MAX_ITEMS = 20;
export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 2000;

export const CATEGORY_SEO_CONTENT_FIELDS = [
  'seoTitle',
  'seoDescription',
  'editorialDecisionGuide',
  'editorialPriceFactors',
  'editorialFaq',
] as const;
export type CategorySeoContentField = (typeof CATEGORY_SEO_CONTENT_FIELDS)[number];

export type FaqItem = { question: string; answer: string };

export type CategorySeoContent = {
  seoTitle: string | null;
  seoDescription: string | null;
  editorialDecisionGuide: string | null;
  editorialPriceFactors: string | null;
  editorialFaq: FaqItem[] | null;
};

/** The fields a request carried, validated; an absent field is absent (unchanged). */
export type CategorySeoContentPatch = Partial<CategorySeoContent>;

function invalid(field: string, message: string): never {
  throw new BadRequestException({ code: 'SEO_CONTENT_INVALID', field, message });
}

function text(field: string, value: unknown, max: number, options: { multiline: boolean }): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') invalid(field, `${field} metin olmalı`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return null;
  const forbidden = options.multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
  if (forbidden.test(normalized)) {
    invalid(field, options.multiline ? `${field} görünmeyen bir karakter içeriyor` : `${field} tek satır olmalı`);
  }
  if (normalized.length > max) invalid(field, `${field} en fazla ${max} karakter olabilir`);
  return normalized;
}

function faq(value: unknown): FaqItem[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) invalid('editorialFaq', 'editorialFaq bir liste olmalı');
  if (value.length === 0) return null;
  if (value.length > FAQ_MAX_ITEMS) invalid('editorialFaq', `En fazla ${FAQ_MAX_ITEMS} soru eklenebilir`);
  return value.map((item, index) => {
    const field = `editorialFaq[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) invalid(field, `${field} soru ve cevap içermeli`);
    const keys = Object.keys(item).sort();
    if (keys.length !== 2 || keys[0] !== 'answer' || keys[1] !== 'question') {
      invalid(field, `${field} yalnız question ve answer alanlarını içermeli`);
    }
    const { question, answer } = item as Record<string, unknown>;
    const q = text(`${field}.question`, question, FAQ_QUESTION_MAX, { multiline: false });
    const a = text(`${field}.answer`, answer, FAQ_ANSWER_MAX, { multiline: true });
    if (q === null || a === null) invalid(field, `${field} boş soru veya cevap içeremez`);
    return { question: q, answer: a };
  });
}

/** The request body, validated field by field. Unknown keys are refused. */
export function parseCategorySeoContentPatch(body: unknown): CategorySeoContentPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('body', 'İstek gövdesi bir nesne olmalı');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CATEGORY_SEO_CONTENT_FIELDS as readonly string[]).includes(key)) invalid(key, `${key} tanınmayan bir alan`);
  }
  const patch: CategorySeoContentPatch = {};
  if ('seoTitle' in record) patch.seoTitle = text('seoTitle', record.seoTitle, SEO_TITLE_MAX, { multiline: false });
  if ('seoDescription' in record) {
    patch.seoDescription = text('seoDescription', record.seoDescription, SEO_DESCRIPTION_MAX, { multiline: false });
  }
  if ('editorialDecisionGuide' in record) {
    patch.editorialDecisionGuide = text('editorialDecisionGuide', record.editorialDecisionGuide, EDITORIAL_BLOCK_MAX, {
      multiline: true,
    });
  }
  if ('editorialPriceFactors' in record) {
    patch.editorialPriceFactors = text('editorialPriceFactors', record.editorialPriceFactors, EDITORIAL_BLOCK_MAX, {
      multiline: true,
    });
  }
  if ('editorialFaq' in record) patch.editorialFaq = faq(record.editorialFaq);
  if (Object.keys(patch).length === 0) invalid('body', 'Değiştirilecek bir alan gönderilmedi');
  return patch;
}

/** The patch as Prisma data; `editorialFaq: null` is a SQL NULL, not a JSON null. */
export function seoContentData(patch: CategorySeoContentPatch): Prisma.ServiceCategoryUpdateInput {
  const data: Prisma.ServiceCategoryUpdateInput = {};
  if (patch.seoTitle !== undefined) data.seoTitle = patch.seoTitle;
  if (patch.seoDescription !== undefined) data.seoDescription = patch.seoDescription;
  if (patch.editorialDecisionGuide !== undefined) data.editorialDecisionGuide = patch.editorialDecisionGuide;
  if (patch.editorialPriceFactors !== undefined) data.editorialPriceFactors = patch.editorialPriceFactors;
  if (patch.editorialFaq !== undefined) {
    data.editorialFaq = patch.editorialFaq === null ? Prisma.DbNull : (patch.editorialFaq as Prisma.InputJsonValue);
  }
  return data;
}

/**
 * A stored FAQ, read back for a public page: the list when it is exactly the
 * shape this module writes, `null` for anything else — a row the API did not
 * write is not rendered on a guess.
 */
export function readStoredFaq(value: unknown): FaqItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: FaqItem[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { question, answer } = item as Record<string, unknown>;
    if (typeof question !== 'string' || typeof answer !== 'string' || !question.trim() || !answer.trim()) return null;
    items.push({ question, answer });
  }
  return items;
}
