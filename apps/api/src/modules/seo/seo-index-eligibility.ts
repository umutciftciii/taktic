import { ProviderServiceAreaScope, ProviderStatus, ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';

/**
 * SEO index eligibility — the one rule that says whether a public page is
 * worth a search engine's index.
 *
 * ## Why a second question beside "is it public"
 *
 * Every public page has a visibility rule already: an ACTIVE leaf category, an
 * APPROVED business, a card whose paid run is on the air. Those decide whether
 * a visitor may *see* the page. They say nothing about whether the page says
 * anything — and a page that says nothing (a category with one sentence and a
 * form, a business with no description, a shelf with two cards) is exactly
 * what Google's own guidance files under thin, doorway and scaled content
 * (SEO-002 §2). So a page can be public and still `noindex`: this module
 * answers the second question, and only the second.
 *
 * ## One place, server side
 *
 * The web reads a boolean (`seoIndexable`) off each public projection and
 * never a threshold; the sitemap endpoint filters with the same functions.
 * That is what makes it impossible for the sitemap to list a page whose own
 * `<head>` says `noindex`, or for JSON-LD to appear on a page the sitemap
 * left out: there is no second copy of the rule to drift.
 *
 * ## Fail closed
 *
 * Every function here answers `false` for input it does not recognise: a
 * status it has not heard of, a description that is not a string, an area
 * row missing the level its scope names, a list that is not a list. Nothing
 * throws; a page the rule cannot vouch for is simply not indexed. The numbers
 * in `SEO_INDEX_THRESHOLDS` are the starting thresholds SEO-002 proposed; they
 * live here and in no setting, flag or admin screen.
 *
 * ## What "characters" means
 *
 * A threshold on length invites padding, so `meaningfulLength` counts only
 * letters and digits after markup, script and style bodies, entities and
 * invisible characters are gone. Whitespace, punctuation, a `<script>` full of
 * filler and a run of zero-width spaces all count for nothing. Turkish letters
 * count like any other letter (`\p{L}`).
 */

export const SEO_INDEX_THRESHOLDS = {
  /** A category needs a real service description, not the one-line catalogue sentence. */
  categoryDescriptionMinChars: 400,
  /** ...and each of the three editorial blocks SEO-002 §5.2 asks for. */
  categoryEditorialBlockMinChars: 80,
  /** A business needs an "about" text a visitor can decide on. */
  providerDescriptionMinChars: 300,
  /** A card needs a summary that is not the title again. */
  showcaseSummaryMinChars: 200,
  /** ...and a scope a customer can check the price against. */
  showcaseScopeIncludedMinItems: 3,
  showcaseScopeExcludedMinItems: 1,
  /** The shelf is a list; below this it is an empty list page. */
  showcaseShelfMinIndexableCards: 5,
} as const;

/**
 * The editorial blocks a category page must carry to be indexable — the
 * decision guide, the price factors and the FAQ of SEO-002 §5.2. No column
 * holds them yet (that is B4); until one does, callers pass nothing here and
 * no category is indexable. When the model arrives, the block texts go in
 * `editorialBlocks` and this rule needs no change.
 */
export const CATEGORY_EDITORIAL_BLOCKS = ['decisionGuide', 'priceFactors', 'faq'] as const;
export type CategoryEditorialBlock = (typeof CATEGORY_EDITORIAL_BLOCKS)[number];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Plain text out of whatever a person typed or pasted: script and style
 * bodies removed, tags removed, entities decoded (an unknown named entity is
 * dropped rather than counted as letters), invisible and control characters
 * removed. Never throws; a non-string is the empty string.
 */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '');
}

function safeChar(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '';
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

/** How many letters and digits a text has once padding of every kind is gone. */
export function meaningfulLength(value: unknown): number {
  const matches = plainText(value).match(/[\p{L}\p{N}]/gu);
  return matches ? matches.length : 0;
}

/**
 * The form two texts are compared in: letters and digits only, lower-cased,
 * single-spaced. "Klima <b>Bakımı</b>!" and "klima bakımı" are the same text.
 */
export function normalizedMeaningfulText(value: unknown): string {
  return plainText(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasMeaningfulText(value: unknown, min: number): boolean {
  return meaningfulLength(value) >= min;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export type CategoryIndexFacts = {
  status: unknown;
  kind: unknown;
  description: unknown;
  /** Absent until B4 gives the category a home for these; absent is not eligible. */
  editorialBlocks?: unknown;
};

/** An ACTIVE leaf with a real description and every editorial block written. */
export function isCategoryIndexable(facts: CategoryIndexFacts | null | undefined): boolean {
  if (!isRecord(facts)) return false;
  if (facts.status !== ServiceCategoryStatus.ACTIVE) return false;
  if (facts.kind !== ServiceCategoryKind.LEAF) return false;
  if (!hasMeaningfulText(facts.description, SEO_INDEX_THRESHOLDS.categoryDescriptionMinChars)) return false;

  const blocks = facts.editorialBlocks;
  if (!isRecord(blocks)) return false;
  return CATEGORY_EDITORIAL_BLOCKS.every((block) =>
    hasMeaningfulText(blocks[block], SEO_INDEX_THRESHOLDS.categoryEditorialBlockMinChars),
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderIndexFacts = {
  status: unknown;
  description: unknown;
  city: unknown;
  district: unknown;
  /** The bindings with each category's `status` and `kind`, as `providerInclude` loads them. */
  serviceCategories: unknown;
  serviceAreas: unknown;
};

/** A binding the public catalogue lists: an ACTIVE leaf. */
function isPublicCategoryBinding(binding: unknown): boolean {
  if (!isRecord(binding) || !isRecord(binding.category)) return false;
  return (
    binding.category.status === ServiceCategoryStatus.ACTIVE &&
    binding.category.kind === ServiceCategoryKind.LEAF
  );
}

/**
 * An area row is complete when every level its scope names is present and
 * no level below the scope is — the same shape the database CHECK enforces,
 * restated so a row that slipped past it is still not vouched for.
 */
function isCompleteServiceArea(area: unknown): boolean {
  if (!isRecord(area)) return false;
  if (!isNonEmptyString(area.city)) return false;
  switch (area.scope) {
    case ProviderServiceAreaScope.CITY:
      return area.district == null && area.neighborhood == null;
    case ProviderServiceAreaScope.DISTRICT:
      return isNonEmptyString(area.district) && area.neighborhood == null;
    case ProviderServiceAreaScope.NEIGHBORHOOD:
      return isNonEmptyString(area.district) && isNonEmptyString(area.neighborhood);
    default:
      return false;
  }
}

/**
 * An approved business with an "about" text of its own, at least one
 * category the public can browse to, and a place: the profile's own
 * province/district and one or more complete service areas. There is no
 * image rule because the model has no image column (SEO-002 P6 / B9).
 */
export function isProviderIndexable(facts: ProviderIndexFacts | null | undefined): boolean {
  if (!isRecord(facts)) return false;
  if (facts.status !== ProviderStatus.APPROVED) return false;
  if (!hasMeaningfulText(facts.description, SEO_INDEX_THRESHOLDS.providerDescriptionMinChars)) return false;
  if (!isNonEmptyString(facts.city) || !isNonEmptyString(facts.district)) return false;

  const bindings = facts.serviceCategories;
  if (!Array.isArray(bindings) || !bindings.some(isPublicCategoryBinding)) return false;

  const areas = facts.serviceAreas;
  if (!Array.isArray(areas) || areas.length === 0) return false;
  return areas.every(isCompleteServiceArea);
}

// ---------------------------------------------------------------------------
// Showcase card and shelf
// ---------------------------------------------------------------------------

export type ShowcaseCardIndexFacts = {
  /** The shelf's own "on the air" predicate, answered by the caller's query. */
  live: unknown;
  /** `isProviderIndexable` for the business behind the card. */
  providerIndexable: unknown;
  summary: unknown;
  scopeIncluded: unknown;
  scopeExcluded: unknown;
  /** Whether another live card of the same business has the same summary. */
  summaryDuplicated: unknown;
};

/** Distinct, meaningful items in a scope list; a copy, a blank or a dash is not one. */
function distinctScopeItems(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalizedMeaningfulText(item);
    if (normalized.length > 0) seen.add(normalized);
  }
  return seen.size;
}

/**
 * A live card of an indexable business, with a summary of its own and a
 * scope a customer can hold the price against: three things it covers and at
 * least one it does not.
 */
export function isShowcaseCardIndexable(facts: ShowcaseCardIndexFacts | null | undefined): boolean {
  if (!isRecord(facts)) return false;
  if (facts.live !== true) return false;
  if (facts.providerIndexable !== true) return false;
  if (facts.summaryDuplicated !== false) return false;
  if (!hasMeaningfulText(facts.summary, SEO_INDEX_THRESHOLDS.showcaseSummaryMinChars)) return false;
  if (distinctScopeItems(facts.scopeIncluded) < SEO_INDEX_THRESHOLDS.showcaseScopeIncludedMinItems) return false;
  return distinctScopeItems(facts.scopeExcluded) >= SEO_INDEX_THRESHOLDS.showcaseScopeExcludedMinItems;
}

/** The shelf lists enough indexable cards to be a list rather than an empty page. */
export function isShowcaseShelfIndexable(indexableLiveCardCount: unknown): boolean {
  return (
    typeof indexableLiveCardCount === 'number' &&
    Number.isInteger(indexableLiveCardCount) &&
    indexableLiveCardCount >= SEO_INDEX_THRESHOLDS.showcaseShelfMinIndexableCards
  );
}

/**
 * The cards of one business, each marked whether its summary is a copy of a
 * sibling's. Used by the loader, which has all of a business's live cards in
 * hand, so the pure card rule can take `summaryDuplicated` as a fact.
 */
export function markDuplicateSummaries<T extends { providerId: string; summary: unknown }>(
  cards: readonly T[],
): Array<T & { summaryDuplicated: boolean }> {
  const counts = new Map<string, number>();
  const keyOf = (card: T) => `${card.providerId}\n${normalizedMeaningfulText(card.summary)}`;
  for (const card of cards) {
    const key = keyOf(card);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return cards.map((card) => ({ ...card, summaryDuplicated: (counts.get(keyOf(card)) ?? 0) > 1 }));
}
