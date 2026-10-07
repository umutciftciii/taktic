import seoPaths from '@taktic/shared/seo-paths.json';

/**
 * SEO-004 — what a category slug may be, decided on the server only.
 *
 * An operator types a name-like text ("Kombi Bakım Servisi"); the slug is
 * derived from it here, never trusted from a client:
 *
 *   Turkish letters transliterated (ş→s, ı/İ→i, ğ→g, ü→u, ö→o, ç→c), other
 *   accents stripped, lower case, every run of anything that is not a-z or
 *   0-9 one dash, no dash at either end, at most {@link CATEGORY_SLUG_MAX_LENGTH}
 *   characters, then the slug rule the API has always held
 *   (`^[a-z0-9]+(-[a-z0-9]+)*$`) and a short reserved list.
 *
 * An input already in slug form comes back unchanged, so the strict
 * `PATCH /categories/:id` DTO and this function agree on every value the DTO
 * admits.
 */

export const CATEGORY_SLUG_MAX_LENGTH: number = seoPaths.slugMaxLength;
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_CATEGORY_SLUGS: readonly string[] = seoPaths.reservedSlugs;

export type CategorySlugRefusal = 'NOT_A_STRING' | 'EMPTY' | 'TOO_LONG' | 'RESERVED';
export type CategorySlugResult = { ok: true; slug: string } | { ok: false; refusal: CategorySlugRefusal };

const TURKISH: Record<string, string> = {
  ş: 's',
  Ş: 's',
  ı: 'i',
  İ: 'i',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
};

export function normalizeCategorySlug(raw: unknown): CategorySlugResult {
  if (typeof raw !== 'string') return { ok: false, refusal: 'NOT_A_STRING' };
  const slug = raw
    .replace(/[şŞıİğĞüÜöÖçÇ]/g, (letter) => TURKISH[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) return { ok: false, refusal: 'EMPTY' };
  if (slug.length > CATEGORY_SLUG_MAX_LENGTH) return { ok: false, refusal: 'TOO_LONG' };
  if (!CATEGORY_SLUG_PATTERN.test(slug)) return { ok: false, refusal: 'EMPTY' };
  if (RESERVED_CATEGORY_SLUGS.includes(slug)) return { ok: false, refusal: 'RESERVED' };
  return { ok: true, slug };
}
