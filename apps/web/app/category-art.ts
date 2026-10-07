/**
 * The category illustrations that shipped with the design handoff.
 *
 * Keyed by the category's `illustrationKey` (SEO-004), not by its slug. The
 * map used to be keyed by slug, so renaming a slug — which an operator may now
 * do, with a 301 from the old address — silently dropped the picture. The key
 * is a column of its own that does not move when the slug does; the migration
 * set it to the seven slugs the illustrations shipped for, which is exactly
 * what this map looked up before. A category without a key — Nakliyat is the
 * known one — has no illustration, and the screens fall back to the icon set
 * rather than inventing a stand-in. An `imageUrl` from the API always wins.
 */
const ILLUSTRATION_BY_KEY: Readonly<Record<string, string>> = {
  'klima-servisi': '/categories/cat-klima-servisi.png',
  'klima-montaji': '/categories/cat-klima-montaji.png',
  'kombi-servisi': '/categories/cat-kombi-servisi.png',
  elektrikci: '/categories/cat-elektrikci.png',
  'su-tesisatcisi': '/categories/cat-su-tesisatcisi.png',
  'boya-badana': '/categories/cat-boya-badana.png',
  'ev-temizligi': '/categories/cat-ev-temizligi.png',
};

export function categoryIllustration(illustrationKey: string | null | undefined): string | null {
  if (!illustrationKey) return null;
  return Object.hasOwn(ILLUSTRATION_BY_KEY, illustrationKey) ? ILLUSTRATION_BY_KEY[illustrationKey]! : null;
}

/** The image a category screen should draw: the API's, then the packaged one. */
export function categoryImageSrc(
  imageUrl: string | null | undefined,
  illustrationKey: string | null | undefined,
): string | null {
  return imageUrl || categoryIllustration(illustrationKey);
}
