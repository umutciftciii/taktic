import type { Category, CategoryFaqItem } from './api';
import { SEO_DESCRIPTION_MAX, seoText } from './seo-metadata';

/**
 * SEO-004 — what a category page prints from the operator's SEO content.
 *
 * Pure, so the fallbacks and the "an empty block is not rendered" rule are
 * unit-tested here rather than through a browser.
 */

export type EditorialSection =
  | { key: 'decisionGuide' | 'priceFactors'; heading: string; paragraphs: string[] }
  | { key: 'faq'; heading: string; items: CategoryFaqItem[] };

/** Blank-line separated paragraphs; a single line break stays inside its paragraph. */
export function paragraphs(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function faqItems(value: unknown): CategoryFaqItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CategoryFaqItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as CategoryFaqItem).question === 'string' &&
      typeof (item as CategoryFaqItem).answer === 'string' &&
      (item as CategoryFaqItem).question.trim().length > 0 &&
      (item as CategoryFaqItem).answer.trim().length > 0,
  );
}

/** The sections to render, in page order. A block with nothing in it is absent. */
export function editorialSections(
  category: Pick<Category, 'editorialDecisionGuide' | 'editorialPriceFactors' | 'editorialFaq'>,
): EditorialSection[] {
  const sections: EditorialSection[] = [];
  const guide = paragraphs(category.editorialDecisionGuide);
  if (guide.length > 0) sections.push({ key: 'decisionGuide', heading: 'Nasıl seçilir?', paragraphs: guide });
  const factors = paragraphs(category.editorialPriceFactors);
  if (factors.length > 0) sections.push({ key: 'priceFactors', heading: 'Fiyatı neler etkiler?', paragraphs: factors });
  const faq = faqItems(category.editorialFaq);
  if (faq.length > 0) sections.push({ key: 'faq', heading: 'Sık sorulan sorular', items: faq });
  return sections;
}

/**
 * The page title: the operator's SEO title as written (it is the whole
 * title, ≤ 70 characters, so the site name is not appended), else the
 * category name with the site name.
 */
export function categoryPageTitle(category: Pick<Category, 'name' | 'seoTitle'>): string | { absolute: string } {
  const seoTitle = category.seoTitle?.trim();
  return seoTitle ? { absolute: seoTitle } : category.name;
}

/**
 * The meta description: the operator's SEO description, else the
 * description-derived snippet, else the plain sentence the page always had.
 * Each candidate goes through `seoText`, so one that carries contact details
 * is skipped rather than printed.
 */
export function categoryPageDescription(category: Pick<Category, 'name' | 'description' | 'seoDescription'>): string {
  return (
    seoText(category.seoDescription, SEO_DESCRIPTION_MAX) ??
    seoText(category.description, SEO_DESCRIPTION_MAX) ??
    `${category.name} için talep oluşturun; bölgenizdeki onaylı hizmet verenlerden teklif alın.`
  );
}
