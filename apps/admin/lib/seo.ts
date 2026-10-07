import seoPaths from '../../../packages/shared/seo-paths.json';

/**
 * SEO-004 PR B — what the four "SEO ve adresler" screens and the category's
 * "Arama motoru" tab read from the admin SEO API (PR A,
 * `apps/api/src/modules/seo/admin/`), and the Turkish an operator reads it in.
 *
 * Kept free of `lib/api` (and so of `next/headers`): the slug, redirect and
 * content forms are client components and import from here.
 *
 * Nothing here decides anything the API decides. The reason codes, the
 * thresholds, the slug a text becomes and every refusal come from the API;
 * this module only names them. The one rule restated on the client — the slug
 * derivation — is a typing preview, held to the shared cases
 * (`packages/shared/seo-paths.json`) the API's own copy is held to, and the
 * API derives the slug again when it saves.
 */

// ---------------------------------------------------------------------------
// The API's shapes
// ---------------------------------------------------------------------------

export type SeoPageType = 'CATEGORY' | 'PROVIDER' | 'SHOWCASE_CARD' | 'SHOWCASE_SHELF';
export const SEO_PAGE_TYPES: readonly SeoPageType[] = ['CATEGORY', 'PROVIDER', 'SHOWCASE_CARD', 'SHOWCASE_SHELF'];

export type SeoEditorialBlock = 'decisionGuide' | 'priceFactors' | 'faq';

export const SEO_INDEX_REASON_CODES = [
  'INPUT_UNRECOGNIZED',
  'CATEGORY_NOT_ACTIVE',
  'CATEGORY_NOT_LEAF',
  'CATEGORY_DESCRIPTION_TOO_SHORT',
  'CATEGORY_EDITORIAL_BLOCK_MISSING',
  'CATEGORY_EDITORIAL_BLOCK_TOO_SHORT',
  'PROVIDER_NOT_APPROVED',
  'PROVIDER_DESCRIPTION_TOO_SHORT',
  'PROVIDER_LOCATION_MISSING',
  'PROVIDER_NO_PUBLIC_CATEGORY',
  'PROVIDER_NO_SERVICE_AREA',
  'PROVIDER_SERVICE_AREA_INCOMPLETE',
  'CARD_NOT_LIVE',
  'CARD_PROVIDER_NOT_INDEXABLE',
  'CARD_SUMMARY_DUPLICATED',
  'CARD_SUMMARY_TOO_SHORT',
  'CARD_SCOPE_INCLUDED_TOO_FEW',
  'CARD_SCOPE_EXCLUDED_TOO_FEW',
  'SHELF_TOO_FEW_INDEXABLE_CARDS',
] as const;
export type SeoIndexReasonCode = (typeof SEO_INDEX_REASON_CODES)[number];

/** One failed rule; `required`/`actual` are the threshold and the count the rule compared. */
export type SeoIndexReason = {
  code: SeoIndexReasonCode | string;
  required?: number;
  actual?: number;
  block?: SeoEditorialBlock;
};

export type SeoIndexEvaluation = { indexable: boolean; reasons: SeoIndexReason[] };

export type SeoThresholds = {
  categoryDescriptionMinChars: number;
  categoryEditorialBlockMinChars: number;
  providerDescriptionMinChars: number;
  showcaseSummaryMinChars: number;
  showcaseScopeIncludedMinItems: number;
  showcaseScopeExcludedMinItems: number;
  showcaseShelfMinIndexableCards: number;
};

export type SeoSiteClosedReason =
  | 'ENVIRONMENT_UNDECLARED'
  | 'ENVIRONMENT_NOT_PRODUCTION'
  | 'ENVIRONMENT_INVALID'
  | 'ORIGIN_MISSING'
  | 'ORIGIN_MALFORMED'
  | 'ORIGIN_NOT_AN_ORIGIN'
  | 'ORIGIN_INSECURE'
  | 'ORIGIN_LOOPBACK';

export type SeoSiteGate =
  | { open: true; origin: string; reason: null; source: string }
  | { open: false; origin: null; reason: SeoSiteClosedReason | string; source: string };

/** `GET /admin/seo/overview`. */
export type SeoOverview = {
  site: SeoSiteGate;
  generatedAt: string;
  sitemapUrlCount: number;
  indexableCount: number;
  nonIndexableCount: number;
  pages: {
    static: { indexable: number };
    categories: { public: number; indexable: number };
    providers: { public: number; indexable: number };
    showcaseCards: { live: number; indexable: number };
    showcaseShelf: { indexable: boolean; indexableCards: number; required: number };
  };
  topReasons: { code: string; count: number }[];
  thresholds: SeoThresholds;
  redirects: { active: number; served: number; notServed: number };
  notFound: { open: number };
};

export type SeoPage<T> = { items: T[]; total: number; page: number; pageSize: number; hasNextPage: boolean };

/** One row of `GET /admin/seo/pages`. */
export type NonIndexablePage = {
  type: SeoPageType;
  id: string;
  label: string;
  owner: string | null;
  path: string;
  reasons: SeoIndexReason[];
};

/** One row of `GET /admin/seo/slugs` — categories only: the one record with a slug. */
export type SeoSlugRow = {
  id: string;
  name: string;
  slug: string;
  path: string;
  kind: 'GROUP' | 'ROUTER' | 'LEAF' | string;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | string;
  publiclyReachable: boolean;
  lastSlugChangeAt: string | null;
  previousAddressCount: number;
};

export type CategorySlugRefusal = 'NOT_A_STRING' | 'EMPTY' | 'TOO_LONG' | 'RESERVED';

/** `GET /admin/seo/categories/:id/slug-preview`. */
export type SeoSlugPreview = {
  slug: string | null;
  refusal: CategorySlugRefusal | string | null;
  currentPath: string;
  newPath: string | null;
  conflict: string | null;
  changes: boolean;
  publiclyReachable?: boolean;
  createsRedirect?: boolean;
  reclaimsRedirectId?: string | null;
  retargetCount?: number;
};

export type SeoRedirectType = 'PERMANENT' | 'TEMPORARY';
export type SeoRedirectOrigin = 'MANUAL' | 'SLUG_CHANGE' | 'NOT_FOUND_SUGGESTION';
export const SEO_REDIRECT_ORIGINS: readonly SeoRedirectOrigin[] = ['MANUAL', 'SLUG_CHANGE', 'NOT_FOUND_SUGGESTION'];

type Actor = { id: string; name: string | null } | null;

/** One row of `GET /admin/seo/redirects`. */
export type SeoRedirect = {
  id: string;
  sourcePath: string;
  targetPath: string;
  type: SeoRedirectType;
  status: 301 | 302;
  active: boolean;
  origin: SeoRedirectOrigin;
  reason: string | null;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  createdBy: Actor;
  updatedBy: Actor;
  deactivatedBy: Actor;
  /** Whether the web answers it right now (inactive, a dead target or a live source: false). */
  served: boolean;
};

export type SeoNotFoundStatus = 'OPEN' | 'APPROVED' | 'REJECTED';
export const SEO_NOT_FOUND_STATUSES: readonly SeoNotFoundStatus[] = ['OPEN', 'APPROVED', 'REJECTED'];

/** One row of `GET /admin/seo/not-found`. */
export type SeoNotFoundSuggestion = {
  id: string;
  path: string;
  routeFamily: 'CATEGORY' | 'PROVIDER' | 'SHOWCASE_CARD' | string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  seenDays: number;
  status: SeoNotFoundStatus;
  candidateTargetPath: string | null;
  decidedAt: string | null;
  redirectId: string | null;
  decidedBy: Actor;
};

export type FaqItem = { question: string; answer: string };

/** `GET /admin/seo/categories/:id/content`. */
export type CategorySeoContent = {
  id: string;
  name: string;
  slug: string;
  path: string;
  seoTitle: string | null;
  seoDescription: string | null;
  editorialDecisionGuide: string | null;
  editorialPriceFactors: string | null;
  editorialFaq: FaqItem[] | null;
  publiclyReachable: boolean;
  evaluation: SeoIndexEvaluation;
};

// ---------------------------------------------------------------------------
// The content limits (apps/api/src/modules/seo/category-seo-content.ts)
// ---------------------------------------------------------------------------

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;
export const EDITORIAL_BLOCK_MAX = 6000;
export const FAQ_MAX_ITEMS = 20;
export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 2000;

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const SEO_PAGE_TYPE_LABELS: Record<SeoPageType, string> = {
  CATEGORY: 'Kategori',
  PROVIDER: 'İşletme',
  SHOWCASE_CARD: 'Vitrin kartı',
  SHOWCASE_SHELF: 'Vitrin rafı',
};

/** The line under a page's name: what kind of page it is. */
export const SEO_PAGE_TYPE_HINTS: Record<SeoPageType, string> = {
  CATEGORY: 'Hizmet kategorisi',
  PROVIDER: 'İşletme profili',
  SHOWCASE_CARD: 'Vitrin kartı',
  SHOWCASE_SHELF: 'Vitrin sayfası',
};

export const SEO_EDITORIAL_BLOCK_LABELS: Record<SeoEditorialBlock, string> = {
  decisionGuide: 'Karar rehberi',
  priceFactors: 'Fiyatı etkileyen faktörler',
  faq: 'Sık sorulan sorular',
};

/** A reason code as a sentence, without its numbers. */
export const SEO_REASON_TITLES: Record<SeoIndexReasonCode, string> = {
  INPUT_UNRECOGNIZED: 'Kayıt kurala göre okunamadı',
  CATEGORY_NOT_ACTIVE: 'Kategori yayında değil',
  CATEGORY_NOT_LEAF: 'Hizmet tipinde değil (grup veya yönlendirici)',
  CATEGORY_DESCRIPTION_TOO_SHORT: 'Açıklama metni çok kısa',
  CATEGORY_EDITORIAL_BLOCK_MISSING: 'İçerik bloğu yazılmamış',
  CATEGORY_EDITORIAL_BLOCK_TOO_SHORT: 'İçerik bloğu çok kısa',
  PROVIDER_NOT_APPROVED: 'İşletme onaylı değil',
  PROVIDER_DESCRIPTION_TOO_SHORT: 'İşletme tanıtım yazısı çok kısa',
  PROVIDER_LOCATION_MISSING: 'İşletmenin il veya ilçesi eksik',
  PROVIDER_NO_PUBLIC_CATEGORY: 'Yayında bir hizmet kategorisi yok',
  PROVIDER_NO_SERVICE_AREA: 'Çalışma bölgesi tanımlı değil',
  PROVIDER_SERVICE_AREA_INCOMPLETE: 'Çalışma bölgesi eksik tanımlı',
  CARD_NOT_LIVE: 'Kart yayında değil',
  CARD_PROVIDER_NOT_INDEXABLE: 'İşletme profili aramaya kapalı',
  CARD_SUMMARY_DUPLICATED: 'Özet, işletmenin başka bir kartıyla aynı',
  CARD_SUMMARY_TOO_SHORT: 'Kart özeti çok kısa',
  CARD_SCOPE_INCLUDED_TOO_FEW: 'Kapsamda yeterli "dahil" yok',
  CARD_SCOPE_EXCLUDED_TOO_FEW: 'Kapsamda "dahil değil" yok',
  SHELF_TOO_FEW_INDEXABLE_CARDS: 'Rafta yeterli kart yok',
};

function isReasonCode(code: string): code is SeoIndexReasonCode {
  return (SEO_INDEX_REASON_CODES as readonly string[]).includes(code);
}

/** The reason filter's label for a code; an unknown code is shown as itself rather than hidden. */
export function seoReasonCodeLabel(code: string): string {
  return isReasonCode(code) ? SEO_REASON_TITLES[code] : code;
}

function count(value: number): string {
  return new Intl.NumberFormat('tr-TR').format(value);
}

/**
 * One failed rule, as an operator reads it: what is wrong, and — where the
 * rule compared numbers — what it needs and what the page has now, from the
 * reason's own `required`/`actual`, never from a constant here.
 */
export function describeSeoReason(reason: SeoIndexReason): { title: string; detail: string | null } {
  const { required, actual } = reason;
  const hasNumbers = typeof required === 'number' && typeof actual === 'number';
  const block = reason.block ? SEO_EDITORIAL_BLOCK_LABELS[reason.block] : null;
  const chars = hasNumbers
    ? `${count(required)} karakter gerek · şu an ${actual === 0 ? 'boş' : `${count(actual)} karakter`}`
    : null;

  switch (reason.code) {
    case 'CATEGORY_DESCRIPTION_TOO_SHORT':
      return { title: SEO_REASON_TITLES[reason.code], detail: chars };
    case 'CATEGORY_EDITORIAL_BLOCK_MISSING':
      return {
        title: block ? `${block} yazılmamış` : SEO_REASON_TITLES[reason.code],
        detail: hasNumbers ? `en az ${count(required)} karakter gerek · şu an boş` : null,
      };
    case 'CATEGORY_EDITORIAL_BLOCK_TOO_SHORT':
      return { title: block ? `${block} çok kısa` : SEO_REASON_TITLES[reason.code], detail: chars };
    case 'PROVIDER_DESCRIPTION_TOO_SHORT':
      return {
        title: hasNumbers && actual === 0 ? 'İşletme tanıtım yazısı yok' : SEO_REASON_TITLES[reason.code],
        detail: chars,
      };
    case 'CARD_SUMMARY_TOO_SHORT':
      return { title: SEO_REASON_TITLES[reason.code], detail: chars };
    case 'CARD_SCOPE_INCLUDED_TOO_FEW':
      return {
        title: SEO_REASON_TITLES[reason.code],
        detail: hasNumbers ? `en az ${count(required)} "dahil" gerek · şu an ${count(actual)}` : null,
      };
    case 'CARD_SCOPE_EXCLUDED_TOO_FEW':
      return {
        title: SEO_REASON_TITLES[reason.code],
        detail: hasNumbers ? `en az ${count(required)} "dahil değil" gerek · şu an ${count(actual)}` : null,
      };
    case 'SHELF_TOO_FEW_INDEXABLE_CARDS':
      return {
        title: SEO_REASON_TITLES[reason.code],
        detail: hasNumbers ? `en az ${count(required)} açık kart gerek · şu an ${count(actual)} kart` : null,
      };
    default:
      return { title: seoReasonCodeLabel(reason.code), detail: null };
  }
}

/** Why the site is closed to search engines, in the words of the overview's band. */
export const SEO_SITE_CLOSED_REASONS: Record<SeoSiteClosedReason, string> = {
  ENVIRONMENT_UNDECLARED: 'Sunucunun ortam bilgisi tanımlı değil.',
  ENVIRONMENT_NOT_PRODUCTION: 'Bu ortam canlı site değil (yerel veya test ortamı).',
  ENVIRONMENT_INVALID: 'Sunucunun ortam bilgisi tanınmıyor.',
  ORIGIN_MISSING: 'Sitenin adresi sunucu yapılandırmasında tanımlı değil.',
  ORIGIN_MALFORMED: 'Sitenin adresi okunamadı.',
  ORIGIN_NOT_AN_ORIGIN: 'Sitenin adresi bir yol veya sorgu içeriyor.',
  ORIGIN_INSECURE: 'Sitenin adresi https değil.',
  ORIGIN_LOOPBACK: 'Sitenin adresi yerel makineyi gösteriyor.',
};

export function seoSiteClosedReason(reason: string | null): string {
  if (reason && reason in SEO_SITE_CLOSED_REASONS) return SEO_SITE_CLOSED_REASONS[reason as SeoSiteClosedReason];
  return 'Sunucu yapılandırması siteyi arama motorlarına açmıyor.';
}

export const SEO_REDIRECT_TYPE_LABELS: Record<SeoRedirectType, { code: string; label: string; badge: string }> = {
  PERMANENT: { code: '301', label: 'Kalıcı', badge: '301 · kalıcı' },
  TEMPORARY: { code: '302', label: 'Geçici', badge: '302 · geçici' },
};

export const SEO_REDIRECT_ORIGIN_LABELS: Record<SeoRedirectOrigin, string> = {
  MANUAL: 'Elle eklendi',
  SLUG_CHANGE: 'Otomatik · adres değişti',
  NOT_FOUND_SUGGESTION: '404 önerisinden',
};

export const SEO_NOT_FOUND_STATUS_LABELS: Record<SeoNotFoundStatus, string> = {
  OPEN: 'İnceleme bekliyor',
  APPROVED: 'Onaylandı',
  REJECTED: 'Reddedildi',
};

export const SEO_ROUTE_FAMILY_LABELS: Record<string, string> = {
  CATEGORY: 'Kategori adresi',
  PROVIDER: 'İşletme adresi',
  SHOWCASE_CARD: 'Vitrin kartı adresi',
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const PATH_REFUSALS: Record<string, string> = {
  NOT_A_STRING: 'adres boş olamaz',
  EMPTY: 'adres boş olamaz',
  ABSOLUTE_URL: 'tam bağlantı (https://…) değil, yalnız site içi yol yazın — örn. /categories/kombi-servisi',
  BACKSLASH: 'ters eğik çizgi (\\) içeremez',
  NOT_ROOTED: '"/" ile başlamalı',
  PROTOCOL_RELATIVE: '"//" ile başlayamaz',
  QUERY: 'soru işareti (?) ve sonrasını içeremez',
  FRAGMENT: '"#" ve sonrasını içeremez',
  ENCODED_SEPARATOR: 'kodlanmış "/" veya "\\" içeremez',
  DOUBLE_ENCODED: 'iki kez kodlanmış karakter içeremez',
  MALFORMED_ENCODING: 'bozuk kodlanmış karakter içeriyor',
  CONTROL_CHARACTER: 'görünmeyen karakter içeriyor',
  WHITESPACE: 'boşluk içeremez',
  EMPTY_SEGMENT: 'art arda iki "/" içeremez',
  DOT_SEGMENT: '"." veya ".." bölümü içeremez',
  TOO_LONG: `en fazla ${seoPaths.pathMaxLength} karakter olabilir`,
};

const SOURCE_REFUSALS: Record<string, string> = {
  ROOT: 'Ana sayfa yönlendirilemez.',
  RESERVED_ROUTE: 'Bu adres sitenin kendi sayfalarından biri (veya bir liste sayfası); yönlendirme kaynağı olamaz.',
  STATIC_ASSET: 'Nokta içeren (dosya gibi görünen) bir adres yönlendirilemez.',
};

const SLUG_REFUSALS: Record<string, string> = {
  NOT_A_STRING: 'Yeni adres boş olamaz.',
  EMPTY: 'Yeni adres en az bir harf veya rakam içermeli.',
  TOO_LONG: `Yeni adres en fazla ${seoPaths.slugMaxLength} karakter olabilir.`,
  RESERVED: 'Bu adres sistem tarafından ayrılmış; kullanılamaz.',
};

export function slugRefusalMessage(refusal: string | null | undefined): string {
  return (refusal && SLUG_REFUSALS[refusal]) || 'Yeni adres kullanılamaz.';
}

const FIELD_LABELS: Record<string, string> = {
  sourcePath: 'Eski adres',
  targetPath: 'Gideceği adres',
  seoTitle: 'SEO başlığı',
  seoDescription: 'SEO açıklaması',
  editorialDecisionGuide: 'Karar rehberi',
  editorialPriceFactors: 'Fiyatı etkileyen faktörler',
  editorialFaq: 'Sık sorulan sorular',
};

/** The body of an API refusal, as the admin SEO routes send it. */
export type SeoRefusal = {
  code?: string;
  field?: string;
  refusal?: string;
  direction?: string;
  message?: string;
};

/**
 * A refusal as one sentence an operator can act on, picked by its code. The
 * API's own message is used only for a content refusal (it names the field and
 * the limit in Turkish already); anything unrecognised gets a plain sentence,
 * never raw response text.
 */
export function seoRefusalMessage(body: SeoRefusal | null, status?: number): string {
  const code = body?.code;
  switch (code) {
    case 'SEO_PATH_INVALID': {
      const field = body?.field ? (FIELD_LABELS[body.field] ?? 'Adres') : 'Adres';
      const why = body?.refusal ? PATH_REFUSALS[body.refusal] : null;
      return why ? `${field} ${why}.` : `${field} geçerli bir site içi yol değil.`;
    }
    case 'SEO_SOURCE_RESERVED':
      return (body?.refusal && SOURCE_REFUSALS[body.refusal]) || 'Bu adres yönlendirme kaynağı olamaz.';
    case 'SEO_SOURCE_IS_LIVE_PAGE':
      return 'Eski adres şu an yayında bir sayfa; yayındaki bir sayfa yönlendirilemez.';
    case 'SEO_SOURCE_TAKEN':
      return 'Bu eski adres için zaten etkin bir yönlendirme var.';
    case 'SEO_TARGET_NOT_CANONICAL':
      return 'Gideceği adres sitenin herkese açık bir sayfası olmalı: ana sayfa, /categories, /categories/…, /isletme/…, /vitrin veya /vitrin/….';
    case 'SEO_TARGET_NOT_LIVE':
      return 'Gideceği adres şu an yayında bir sayfa değil.';
    case 'SEO_REDIRECT_TO_ITSELF':
      return 'Bir adres kendisine yönlendirilemez (döngü).';
    case 'SEO_REDIRECT_CHAIN':
      return body?.direction === 'SOURCE_IS_TARGET'
        ? 'Bu eski adrese yönlenen başka yönlendirmeler var; zincir veya döngü oluşur (A→B→C). Kayıt kabul edilmedi.'
        : 'Gideceği adresin kendisi de yönlendiriliyor; zincir veya döngü oluşur (A→B→C). Kayıt kabul edilmedi.';
    case 'SEO_REDIRECT_NOT_FOUND':
      return 'Yönlendirme bulunamadı.';
    case 'SEO_REDIRECT_INACTIVE':
      return 'Bu yönlendirme kaldırılmış; değiştirilemez.';
    case 'SEO_SLUG_REDIRECT_PERMANENT':
      return 'Adres değişikliğinden doğan yönlendirme kalıcı (301) kalmalı.';
    case 'SEO_REASON_REQUIRED':
      return 'Sebep yazılmalı.';
    case 'SEO_REASON_INVALID':
      return 'Sebep en fazla 500 karakter olabilir.';
    case 'SEO_TARGET_REQUIRED':
      return 'Gideceği adres seçilmeli.';
    case 'SEO_SUGGESTION_NOT_FOUND':
      return 'Öneri bulunamadı.';
    case 'SEO_SUGGESTION_ALREADY_DECIDED':
      return 'Bu öneri için zaten karar verilmiş; liste yenilendi.';
    case 'CATEGORY_SLUG_INVALID':
      return slugRefusalMessage(body?.refusal);
    case 'CATEGORY_SLUG_TAKEN':
      return 'Bu adres başka bir kategoride kullanılıyor.';
    case 'SLUG_HELD_BY_REDIRECT':
      return 'Bu adres etkin bir yönlendirmenin eski adresi. Önce o yönlendirme kaldırılmalı.';
    case 'CATEGORY_NOT_FOUND':
      return 'Kategori bulunamadı.';
    case 'SEO_CONTENT_INVALID':
      return body?.message ? contentMessage(body.message) : 'İçerik kaydedilemedi: alanları kontrol edin.';
    default:
      if (status === 409) return 'Kayıt bu arada değişti; sayfayı yenileyip yeniden deneyin.';
      if (status === 404) return 'Kayıt bulunamadı.';
      return 'İşlem tamamlanamadı. Tekrar deneyin.';
  }
}

/** A content refusal's message, with the API field name swapped for its label. */
function contentMessage(message: string): string {
  let text = message;
  for (const [name, label] of Object.entries(FIELD_LABELS)) text = text.split(name).join(label);
  return text.endsWith('.') ? text : `${text}.`;
}

/** Parses an API error body; anything that is not a JSON object is no refusal at all. */
export function readSeoRefusal(body: string): SeoRefusal | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SeoRefusal) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The slug, as the API derives it — a typing preview only
// ---------------------------------------------------------------------------

export const CATEGORY_SLUG_MAX_LENGTH: number = seoPaths.slugMaxLength;
const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_CATEGORY_SLUGS: readonly string[] = seoPaths.reservedSlugs;

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

/**
 * `apps/api/src/modules/seo/category-slug.ts`, restated for the modal's live
 * "yeni adres" line. The API ignores this: it derives the slug from the text
 * again and decides collisions, reservations and redirects itself.
 */
export function previewCategorySlug(raw: string): { ok: true; slug: string } | { ok: false; refusal: CategorySlugRefusal } {
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

// ---------------------------------------------------------------------------
// Where "Aç" goes
// ---------------------------------------------------------------------------

/**
 * The admin screen that owns a non-indexable page, when there is one and the
 * session may open it; null otherwise. There is no SEO page detail screen
 * (`seoPageDetail` is out of this PR): "Aç" goes to the record's own admin
 * screen, where the missing content is written. The vitrin shelf is not a
 * record and has no screen, so it gets no link rather than a made-up one.
 */
export function seoPageAdminHref(page: Pick<NonIndexablePage, 'type' | 'id' | 'path'>, can: (permission: string) => boolean): string | null {
  switch (page.type) {
    case 'CATEGORY': {
      const slug = page.path.startsWith('/categories/') ? page.path.slice('/categories/'.length) : null;
      return slug && can('CATALOG_READ') ? `/categories/${encodeURIComponent(slug)}` : null;
    }
    case 'PROVIDER':
      return can('PROVIDERS_READ_DETAIL') ? `/providers/${encodeURIComponent(page.id)}` : null;
    case 'SHOWCASE_CARD':
      return can('SHOWCASE_CARDS_READ') ? `/showcase/cards?cardId=${encodeURIComponent(page.id)}` : null;
    default:
      return null;
  }
}
