/**
 * The category illustrations that shipped with the design handoff.
 *
 * These are the real brand illustrations, keyed by the category slugs the seed
 * creates. A slug that is not listed here — Nakliyat is the known one — has no
 * illustration, and the screens fall back to the icon set rather than inventing
 * a stand-in. An `imageUrl` coming from the API always wins over this map.
 */
const ILLUSTRATION_BY_SLUG: Readonly<Record<string, string>> = {
  'klima-servisi': '/categories/cat-klima-servisi.png',
  'klima-montaji': '/categories/cat-klima-montaji.png',
  'kombi-servisi': '/categories/cat-kombi-servisi.png',
  elektrikci: '/categories/cat-elektrikci.png',
  'su-tesisatcisi': '/categories/cat-su-tesisatcisi.png',
  'boya-badana': '/categories/cat-boya-badana.png',
  'ev-temizligi': '/categories/cat-ev-temizligi.png',
};

export function categoryIllustration(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return ILLUSTRATION_BY_SLUG[slug] ?? null;
}

/** The image a category screen should draw: the API's, then the packaged one. */
export function categoryImageSrc(
  imageUrl: string | null | undefined,
  slug: string | null | undefined,
): string | null {
  return imageUrl || categoryIllustration(slug);
}
