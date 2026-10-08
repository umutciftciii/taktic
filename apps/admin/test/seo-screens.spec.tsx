import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import seoPaths from '../../../packages/shared/seo-paths.json';
import {
  describeSeoReason,
  previewCategorySlug,
  seoPageAdminHref,
  seoRefusalMessage,
  type CategorySeoContent,
  type NonIndexablePage,
  type SeoNotFoundSuggestion,
  type SeoOverview,
  type SeoRedirect,
  type SeoSlugRow,
} from '../lib/seo';

/**
 * SEO-004 PR B — the four "SEO ve adresler" screens and the category's
 * "Arama motoru" tab, rendered as the server renders them, against API answers
 * shaped like PR A's. Each case pins one promise of the brief: real figures
 * only (no visits, no hit counts, no sitemap timestamp), reasons with their own
 * required/actual, the mandatory 301 said where it is decided and no opt-out,
 * the source of a redirect fixed after creation, write controls only with the
 * write permission, and the slug no longer a field of the category form.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

class Redirect extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super('NEXT_REDIRECT');
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ name: 'taktic_session', value: 'staff' }), toString: () => '' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  usePathname: () => '/seo',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const apiFetch = vi.fn();
let held = new Set<string>();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  requireAdmin: async (...required: string[]) => {
    if (!required.every((permission) => held.has(permission))) throw new Redirect('/yetkisiz');
    return {
      user: { id: 'u-1' },
      isSuperAdmin: false,
      permissions: [...held],
      can: (...names: string[]) => names.every((name) => held.has(name)),
    };
  },
}));

const { default: SeoOverviewPage } = await import('../app/seo/(overview)/page');
const { default: SeoIndexingPage } = await import('../app/seo/indexing/page');
const { default: SeoSlugsPage } = await import('../app/seo/slugs/page');
const { default: SeoRedirectsPage } = await import('../app/seo/redirects/page');
const { SlugChangeForm, PUBLIC_SLUG_REDIRECT_COPY, NON_PUBLIC_SLUG_REDIRECT_COPY } = await import(
  '../app/seo/slugs/slug-change-form'
);
const { CategorySeoSection } = await import('../app/categories/[slug]/category-seo-section');
const { CategoryInfoSection } = await import('../app/categories/[slug]/category-sections');
const actions = await import('../app/seo/actions');
const { ApiError } = await import('../lib/api');

/** Answers each GET by its path; writes answer `write`. */
function routes(table: Record<string, unknown>, write: unknown = {}) {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method && init.method !== 'GET') return write;
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => path.startsWith(prefix));
    if (!key) throw new Error(`unexpected GET ${path}`);
    return table[key];
  });
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

beforeEach(() => {
  apiFetch.mockReset();
  held = new Set(['SEO_READ']);
});

// ─────────────────────────── fixtures ───────────────────────────

const OVERVIEW: SeoOverview = {
  site: { open: false, origin: null, reason: 'ENVIRONMENT_NOT_PRODUCTION', source: 'API_ENVIRONMENT' },
  generatedAt: '2026-10-07T10:00:00.000Z',
  sitemapUrlCount: 0,
  indexableCount: 7,
  nonIndexableCount: 13,
  pages: {
    static: { indexable: 2 },
    categories: { public: 9, indexable: 4 },
    providers: { public: 6, indexable: 1 },
    showcaseCards: { live: 3, indexable: 2 },
    showcaseShelf: { indexable: false, indexableCards: 2, required: 5 },
  },
  topReasons: [{ code: 'CATEGORY_DESCRIPTION_TOO_SHORT', count: 5 }],
  // Not the product's numbers on purpose: the screen must print what it is given.
  thresholds: {
    categoryDescriptionMinChars: 401,
    categoryEditorialBlockMinChars: 81,
    providerDescriptionMinChars: 301,
    showcaseSummaryMinChars: 201,
    showcaseScopeIncludedMinItems: 3,
    showcaseScopeExcludedMinItems: 1,
    showcaseShelfMinIndexableCards: 5,
  },
  redirects: { active: 11, served: 10, notServed: 1 },
  notFound: { open: 4 },
};

const PAGES: NonIndexablePage[] = [
  {
    type: 'CATEGORY',
    id: 'cat-1',
    label: 'Cam balkon',
    owner: null,
    path: '/categories/cam-balkon',
    reasons: [
      { code: 'CATEGORY_DESCRIPTION_TOO_SHORT', required: 400, actual: 217 },
      { code: 'CATEGORY_EDITORIAL_BLOCK_MISSING', block: 'faq', required: 80, actual: 0 },
    ],
  },
  { type: 'PROVIDER', id: 'pro-1', label: 'Deniz Elektrik', owner: null, path: '/isletme/pro-1', reasons: [{ code: 'PROVIDER_DESCRIPTION_TOO_SHORT', required: 300, actual: 0 }] },
  { type: 'SHOWCASE_CARD', id: 'card-1', label: 'Kombi bakımı', owner: 'Yıldız Kombi', path: '/vitrin/card-1', reasons: [{ code: 'CARD_SCOPE_INCLUDED_TOO_FEW', required: 3, actual: 2 }] },
  { type: 'SHOWCASE_SHELF', id: 'vitrin', label: 'Vitrin', owner: null, path: '/vitrin', reasons: [{ code: 'SHELF_TOO_FEW_INDEXABLE_CARDS', required: 5, actual: 2 }] },
];

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 25, hasNextPage: false });

const SLUGS: SeoSlugRow[] = [
  { id: 'cat-1', name: 'Kombi servisi', slug: 'kombi-servisi', path: '/categories/kombi-servisi', kind: 'LEAF', status: 'ACTIVE', publiclyReachable: true, lastSlugChangeAt: '2026-10-01T09:00:00.000Z', previousAddressCount: 2 },
  { id: 'cat-2', name: 'Taslak hizmet', slug: 'taslak-hizmet', path: '/categories/taslak-hizmet', kind: 'LEAF', status: 'DRAFT', publiclyReachable: false, lastSlugChangeAt: null, previousAddressCount: 0 },
];

const CONTENT: CategorySeoContent = {
  id: 'cat-1',
  name: 'Kombi servisi',
  slug: 'kombi-servisi',
  path: '/categories/kombi-servisi',
  seoTitle: 'Kombi servisi',
  seoDescription: null,
  editorialDecisionGuide: null,
  editorialPriceFactors: 'Kısa',
  editorialFaq: [{ question: 'Ne kadar sürer?', answer: 'Genelde bir saat.' }],
  publiclyReachable: true,
  evaluation: {
    indexable: false,
    reasons: [
      { code: 'CATEGORY_DESCRIPTION_TOO_SHORT', required: 400, actual: 217 },
      { code: 'CATEGORY_EDITORIAL_BLOCK_TOO_SHORT', block: 'priceFactors', required: 80, actual: 4 },
    ],
  },
};

const REDIRECT = (over: Partial<SeoRedirect> = {}): SeoRedirect => ({
  id: 'r-1',
  sourcePath: '/categories/kombi-tamiri',
  targetPath: '/categories/kombi-servisi',
  type: 'PERMANENT',
  status: 301,
  active: true,
  origin: 'MANUAL',
  reason: 'eski site yapısı',
  categoryId: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  deactivatedAt: null,
  createdBy: { id: 'u-1', name: 'Umut' },
  updatedBy: null,
  deactivatedBy: null,
  served: true,
  ...over,
});

const SUGGESTION = (over: Partial<SeoNotFoundSuggestion> = {}): SeoNotFoundSuggestion => ({
  id: 's-1',
  path: '/categories/kombi-tamir',
  routeFamily: 'CATEGORY',
  firstSeenAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-06T09:00:00.000Z',
  occurrenceCount: 14,
  seenDays: 4,
  status: 'OPEN',
  candidateTargetPath: '/categories/kombi-servisi',
  decidedAt: null,
  redirectId: null,
  decidedBy: null,
  ...over,
});

// ─────────────────────────── route guards ───────────────────────────

describe('every SEO screen asks for SEO_READ before anything is read', () => {
  const screens: Array<[string, () => Promise<unknown>]> = [
    ['/seo', () => SeoOverviewPage()],
    ['/seo/indexing', () => SeoIndexingPage({ searchParams: Promise.resolve({}) })],
    ['/seo/slugs', () => SeoSlugsPage({ searchParams: Promise.resolve({}) })],
    ['/seo/redirects', () => SeoRedirectsPage({ searchParams: Promise.resolve({}) })],
  ];

  it.each(screens)('%s sends a session without it to /yetkisiz', async (_path, render) => {
    held = new Set(['CATALOG_READ', 'SEO_CONTENT_WRITE', 'SEO_REDIRECTS_WRITE']);
    await expect(render()).rejects.toMatchObject({ url: '/yetkisiz' });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── overview ───────────────────────────

describe('Arama motoru durumu', () => {
  it('prints the API’s figures and thresholds, never the design’s fixtures', async () => {
    routes({ '/admin/seo/overview': OVERVIEW });
    const out = html((await SeoOverviewPage()) as React.ReactElement);
    expect(out).toContain('data-metric="seo-indexable"');
    expect(out).toMatch(/seo-metric is-good">7</);
    expect(out).toMatch(/seo-metric is-warn">13</);
    expect(out).toContain('11');
    expect(out).toContain('1 tanesi şu an uygulanmıyor');
    expect(out).toContain('İnceleme bekleyen 404 önerisi');
    // The shelf is one page: 0 / 1, with its real card count.
    expect(out).toMatch(/data-testid="seo-type-shelf-count">0 \/ 1</);
    expect(out).toContain('Aramaya uygun 2 kart var · en az 5 gerek');
    expect(out).toMatch(/data-testid="seo-type-categories-count">4 \/ 9</);
    expect(out).toContain('5 kategoride açıklama veya içerik bloğu eksik');
    for (const threshold of ['en az 401 karakter', 'her biri en az 81 karakter', 'en az 301 karakter', 'en az 201 karakter']) {
      expect(out).toContain(threshold);
    }
  });

  it('says the sitemap is built per request and shows no visit, hit or "last generated" figure', async () => {
    routes({ '/admin/seo/overview': OVERVIEW });
    const out = html((await SeoOverviewPage()) as React.ReactElement);
    expect(out).toContain('İstek anında üretilir');
    expect(out).not.toMatch(/30 gün|ziyaret|kez kullanıldı|günde \d|son güncelleme|saat önce/i);
  });

  it('a closed site says why, lists nothing in the sitemap and offers no sitemap link', async () => {
    routes({ '/admin/seo/overview': OVERVIEW });
    const out = html((await SeoOverviewPage()) as React.ReactElement);
    expect(out).toContain('Site aramaya kapalı');
    expect(out).toContain('Bu ortam canlı site değil');
    expect(out).toMatch(/data-testid="seo-sitemap-count">0 adres</);
    expect(out).not.toContain('seo-sitemap-link');
  });

  it('an open site links its own sitemap', async () => {
    routes({
      '/admin/seo/overview': {
        ...OVERVIEW,
        site: { open: true, origin: 'https://taktick.com', reason: null, source: 'API_ENVIRONMENT' },
        sitemapUrlCount: 7,
        pages: { ...OVERVIEW.pages, showcaseShelf: { indexable: true, indexableCards: 6, required: 5 } },
      },
    });
    const out = html((await SeoOverviewPage()) as React.ReactElement);
    expect(out).toContain('Site aramaya açık');
    expect(out).toContain('href="https://taktick.com/sitemap.xml"');
    expect(out).toMatch(/data-testid="seo-type-shelf-count">1 \/ 1</);
  });
});

// ─────────────────────────── reasons ───────────────────────────

describe('a reason, in Turkish, with its own numbers', () => {
  it('length rules say what is needed and what there is', () => {
    expect(describeSeoReason({ code: 'CATEGORY_DESCRIPTION_TOO_SHORT', required: 400, actual: 217 })).toEqual({
      title: 'Açıklama metni çok kısa',
      detail: '400 karakter gerek · şu an 217 karakter',
    });
    expect(describeSeoReason({ code: 'CATEGORY_EDITORIAL_BLOCK_MISSING', block: 'faq', required: 80, actual: 0 })).toEqual({
      title: 'Sık sorulan sorular yazılmamış',
      detail: 'en az 80 karakter gerek · şu an boş',
    });
    expect(describeSeoReason({ code: 'CATEGORY_EDITORIAL_BLOCK_TOO_SHORT', block: 'decisionGuide', required: 80, actual: 31 })).toEqual({
      title: 'Karar rehberi çok kısa',
      detail: '80 karakter gerek · şu an 31 karakter',
    });
    expect(describeSeoReason({ code: 'PROVIDER_DESCRIPTION_TOO_SHORT', required: 300, actual: 0 }).title).toBe(
      'İşletme tanıtım yazısı yok',
    );
    expect(describeSeoReason({ code: 'CARD_SCOPE_INCLUDED_TOO_FEW', required: 3, actual: 2 }).detail).toBe(
      'en az 3 "dahil" gerek · şu an 2',
    );
    expect(describeSeoReason({ code: 'SHELF_TOO_FEW_INDEXABLE_CARDS', required: 5, actual: 2 }).detail).toBe(
      'en az 5 açık kart gerek · şu an 2 kart',
    );
  });

  it('a rule without numbers has no detail, and an unknown code is shown as itself', () => {
    expect(describeSeoReason({ code: 'CATEGORY_NOT_ACTIVE' })).toEqual({ title: 'Kategori yayında değil', detail: null });
    expect(describeSeoReason({ code: 'SOMETHING_NEW' })).toEqual({ title: 'SOMETHING_NEW', detail: null });
  });
});

// ─────────────────────────── non-indexable pages ───────────────────────────

describe('İndekslenmeyen sayfalar', () => {
  it('lists each page with its type, address, reasons and required/actual', async () => {
    routes({ '/admin/seo/pages': page(PAGES) });
    const out = html((await SeoIndexingPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(out).toContain('Cam balkon');
    expect(out).toContain('/categories/cam-balkon');
    expect(out).toContain('400 karakter gerek · şu an 217 karakter');
    expect(out).toContain('Sık sorulan sorular yazılmamış');
    expect(out).toContain('Yıldız Kombi');
    expect(out).toContain('Aramaya kapalı');
    // The design's date/status filters and export are not drawn.
    expect(out).not.toMatch(/Excel|Son 30 gün|name="tarih"/);
  });

  it('sends exactly the filters the API takes, and drops one it would refuse', async () => {
    routes({ '/admin/seo/pages': page([]) });
    await SeoIndexingPage({ searchParams: Promise.resolve({ type: 'PROVIDER', reason: 'PROVIDER_NOT_APPROVED', q: 'deniz' }) });
    expect(apiFetch.mock.calls[0]![0]).toBe('/admin/seo/pages?type=PROVIDER&reason=PROVIDER_NOT_APPROVED&q=deniz&page=1&pageSize=25');
    apiFetch.mockClear();
    await SeoIndexingPage({ searchParams: Promise.resolve({ type: 'HACK', reason: 'NOPE' }) });
    expect(apiFetch.mock.calls[0]![0]).toBe('/admin/seo/pages?page=1&pageSize=25');
  });

  it('"Aç" goes to the record’s own screen when the session may open it — the shelf gets none', () => {
    const all = () => true;
    expect(seoPageAdminHref(PAGES[0]!, all)).toBe('/categories/cam-balkon');
    expect(seoPageAdminHref(PAGES[1]!, all)).toBe('/providers/pro-1');
    expect(seoPageAdminHref(PAGES[2]!, all)).toBe('/showcase/cards?cardId=card-1');
    expect(seoPageAdminHref(PAGES[3]!, all)).toBeNull();
    expect(seoPageAdminHref(PAGES[1]!, (permission) => permission !== 'PROVIDERS_READ_DETAIL')).toBeNull();
  });

  it('draws no "Aç" for a page the session cannot open, and says so when the list is empty', async () => {
    routes({ '/admin/seo/pages': page(PAGES) });
    const out = html((await SeoIndexingPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(out).not.toContain('data-testid="seo-indexing-open"');
    held.add('CATALOG_READ');
    const withCatalogue = html((await SeoIndexingPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(withCatalogue.match(/data-testid="seo-indexing-open"/g)).toHaveLength(1);

    routes({ '/admin/seo/pages': page([]) });
    const empty = html((await SeoIndexingPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(empty).toContain('Aramaya kapalı sayfa yok');
  });
});

// ─────────────────────────── slugs ───────────────────────────

describe('Adresler', () => {
  it('lists categories only, with status, last change and the old-address count — no visit column', async () => {
    routes({ '/admin/seo/slugs': page(SLUGS) });
    const out = html((await SeoSlugsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(out).toContain('/categories/kombi-servisi');
    expect(out).toContain('2 eski adres');
    expect(out).toContain('Herkese kapalı');
    expect(out).toContain('Değişmedi');
    expect(out).not.toMatch(/ziyaret|30 gün|\/isletme\/|\/vitrin\//i);
  });

  it('offers "Adresi değiştir" only with CATEGORIES_WRITE — the API’s slug permission', async () => {
    routes({ '/admin/seo/slugs': page(SLUGS) });
    const without = html((await SeoSlugsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(without).not.toContain('data-testid="seo-slug-change"');
    held.add('CATEGORIES_WRITE');
    const withWrite = html((await SeoSlugsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(withWrite.match(/data-testid="seo-slug-change"/g)).toHaveLength(2);
  });

  it('opens the window at ?kategori=, and returns to the category when it came from there', async () => {
    held.add('CATEGORIES_WRITE');
    routes({ '/admin/seo/slugs': page(SLUGS), '/admin/seo/categories/cat-1/content': CONTENT });
    const out = html(
      (await SeoSlugsPage({ searchParams: Promise.resolve({ kategori: 'cat-1', geri: 'kategori' }) })) as React.ReactElement,
    );
    expect(out).toContain('data-testid="seo-slug-dialog"');
    expect(out).toContain('name="returnTo" value="category"');
    expect(out).toContain('href="/categories/kombi-servisi"');
  });

  it('says the result: the new address and whether the 301 was written', async () => {
    routes({ '/admin/seo/slugs': page(SLUGS) });
    const out = html(
      (await SeoSlugsPage({ searchParams: Promise.resolve({ adres: '/categories/kombi-bakim', yonlendirme: '1' }) })) as React.ReactElement,
    );
    expect(out).toContain('Adres değiştirildi');
    expect(out).toContain('kalıcı (301)');
  });
});

describe('the slug window', () => {
  const render = (publiclyReachable: boolean) =>
    html(
      <SlugChangeForm
        categoryId="cat-1"
        categoryName="Kombi servisi"
        currentSlug="kombi-servisi"
        publiclyReachable={publiclyReachable}
        cancelHref="/seo/slugs"
        returnTo="list"
      />,
    );

  it('a public category: the 301 is said, and there is no switch to turn it off', () => {
    const out = render(true);
    expect(out).toContain(PUBLIC_SLUG_REDIRECT_COPY);
    expect(PUBLIC_SLUG_REDIRECT_COPY).toBe('Eski adres otomatik olarak yeni adrese kalıcı (301) yönlendirilir.');
    expect(out).not.toContain('type="checkbox"');
    expect(out).not.toMatch(/otomatik yönlendirme oluştur|kapatırsanız/i);
    expect(out).toContain('/categories/');
    expect(out).toContain('data-testid="seo-slug-submit"');
  });

  it('a category that is not public: no redirect is written, and the window says so', () => {
    const out = render(false);
    expect(out).toContain(NON_PUBLIC_SLUG_REDIRECT_COPY);
    expect(out).not.toContain(PUBLIC_SLUG_REDIRECT_COPY);
  });

  it('the save is a confirmation with its own proof, shut until a usable address is typed', () => {
    const source = read('app/seo/slugs/slug-change-form.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="seo.slug-change"/);
    expect(render(true)).toMatch(/data-testid="seo-slug-submit"[^>]*disabled=""|disabled=""[^>]*data-testid="seo-slug-submit"/);
  });

  it('the typing preview derives the slug the API does — the shared cases', () => {
    for (const { input, slug, refusal } of seoPaths.slugCases as { input: string; slug?: string; refusal?: string }[]) {
      expect(previewCategorySlug(input), input).toEqual(slug ? { ok: true, slug } : { ok: false, refusal });
    }
    expect(previewCategorySlug('yeni')).toEqual({ ok: false, refusal: 'RESERVED' });
    expect(previewCategorySlug('!!!')).toEqual({ ok: false, refusal: 'EMPTY' });
    expect(previewCategorySlug('a'.repeat(81))).toEqual({ ok: false, refusal: 'TOO_LONG' });
  });

  it('the API’s refusals read as what to do', () => {
    expect(seoRefusalMessage({ code: 'CATEGORY_SLUG_TAKEN' })).toBe('Bu adres başka bir kategoride kullanılıyor.');
    expect(seoRefusalMessage({ code: 'SLUG_HELD_BY_REDIRECT' })).toContain('etkin bir yönlendirmenin eski adresi');
    expect(seoRefusalMessage({ code: 'CATEGORY_SLUG_INVALID', refusal: 'RESERVED' })).toContain('ayrılmış');
    expect(seoRefusalMessage({ code: 'CATEGORY_SLUG_INVALID', refusal: 'EMPTY' })).toContain('en az bir harf');
  });
});

describe('the slug actions', () => {
  it('a refusal comes back as state with the message for its code; nothing redirects', async () => {
    const { issueConfirmationProof } = await import('../lib/confirmation-proof-server');
    apiFetch.mockImplementation(async () => {
      throw new ApiError(409, JSON.stringify({ code: 'CATEGORY_SLUG_TAKEN', message: 'Category slug already exists' }));
    });
    const data = new FormData();
    data.set('categoryId', 'cat-1');
    data.set('slug', 'klima');
    data.set('__confirmationProof', (await issueConfirmationProof('seo.slug-change'))!);
    const state = await actions.changeCategorySlugAction({ kind: 'idle' }, data);
    expect(state).toMatchObject({ kind: 'error', message: 'Bu adres başka bir kategoride kullanılıyor.', code: 'CATEGORY_SLUG_TAKEN' });
  });

  it('a success from the category’s own screen returns there, at the new address', async () => {
    const { issueConfirmationProof } = await import('../lib/confirmation-proof-server');
    routes({}, { category: { slug: 'kombi-bakim', path: '/categories/kombi-bakim' }, redirect: { sourcePath: '/categories/kombi-servisi' } });
    const data = new FormData();
    data.set('categoryId', 'cat-1');
    data.set('slug', 'Kombi Bakım');
    data.set('returnTo', 'category');
    data.set('__confirmationProof', (await issueConfirmationProof('seo.slug-change'))!);
    await expect(actions.changeCategorySlugAction({ kind: 'idle' }, data)).rejects.toMatchObject({
      url: '/categories/kombi-bakim?adres=%2Fcategories%2Fkombi-bakim&yonlendirme=1',
    });
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ slug: 'Kombi Bakım' });
  });
});

// ─────────────────────────── redirects ───────────────────────────

describe('Yönlendirmeler', () => {
  it('reads with SEO_READ and draws no write control without SEO_REDIRECTS_WRITE', async () => {
    routes({ '/admin/seo/redirects': page([REDIRECT(), REDIRECT({ id: 'r-2', type: 'TEMPORARY', status: 302 })]) });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(out).toContain('301 · kalıcı');
    expect(out).toContain('302 · geçici');
    expect(out).toContain('/categories/kombi-tamiri');
    expect(out).toContain('eski site yapısı');
    for (const control of ['seo-redirect-new', 'seo-redirect-edit', 'seo-redirect-deactivate']) {
      expect(out).not.toContain(`data-testid="${control}"`);
    }
    // No hit counts: the API keeps none.
    expect(out).not.toMatch(/30 günde|Son kullanım|kullanıldı/);
  });

  it('with the write permission: add, edit and a confirmed "Kaldır" — a deactivate, never a delete', async () => {
    held.add('SEO_REDIRECTS_WRITE');
    routes({ '/admin/seo/redirects': page([REDIRECT()]) });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
    expect(out).toContain('data-testid="seo-redirect-new"');
    expect(out).toContain('data-testid="seo-redirect-edit"');
    expect(out).toContain('data-testid="seo-redirect-deactivate"');
    const source = read('app/seo/redirects/page.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="seo.redirect-deactivate"\s+triggerLabel="Kaldır"/);
    expect(read('app/seo/actions.ts')).not.toMatch(/method: 'DELETE'/);
  });

  it('an inactive row and one the web is not serving say so; neither offers edit', async () => {
    held.add('SEO_REDIRECTS_WRITE');
    routes({
      '/admin/seo/redirects': page([
        REDIRECT({ id: 'r-3', active: false, served: false, deactivatedAt: '2026-10-05T09:00:00.000Z' }),
        REDIRECT({ id: 'r-4', served: false }),
      ]),
    });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ durum: 'tumu' }) })) as React.ReactElement);
    expect(out).toContain('Kaldırıldı');
    expect(out).toContain('Şu an uygulanmıyor');
    expect(out.match(/data-testid="seo-redirect-edit"/g)).toHaveLength(1);
    expect(apiFetch.mock.calls[0]![0]).toBe('/admin/seo/redirects?page=1&pageSize=25');
  });

  it('the new-redirect window: source, target, 301 Kalıcı / 302 Geçici, reason and the checks', async () => {
    held.add('SEO_REDIRECTS_WRITE');
    routes({ '/admin/seo/redirects': page([]), '/admin/seo/slugs': page(SLUGS) });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ yonlendirme: 'yeni' }) })) as React.ReactElement);
    expect(out).toContain('data-testid="seo-redirect-source"');
    expect(out).toContain('Kalıcı (301)');
    expect(out).toContain('Geçici (302)');
    expect(out).toContain('zincir (A→B→C)');
    // The target suggestions are live canonical pages only — the draft is not one.
    expect(out).toContain('<option value="/categories/kombi-servisi">');
    expect(out).not.toContain('<option value="/categories/taslak-hizmet">');
  });

  it('the edit window: the source is fixed; a slug-change redirect cannot change type', async () => {
    held.add('SEO_REDIRECTS_WRITE');
    routes({
      '/admin/seo/redirects/r-9': { redirect: REDIRECT({ id: 'r-9', origin: 'SLUG_CHANGE' }), history: {} },
      '/admin/seo/redirects': page([]),
      '/admin/seo/slugs': page(SLUGS),
    });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ yonlendirme: 'r-9' }) })) as React.ReactElement);
    expect(out).toContain('data-testid="seo-redirect-source-locked"');
    expect(out).not.toContain('data-testid="seo-redirect-source"');
    expect(out).not.toContain('name="type"');
    expect(out).toContain('adres değişikliğinden doğdu');

    routes({
      '/admin/seo/redirects/r-8': { redirect: REDIRECT({ id: 'r-8' }), history: {} },
      '/admin/seo/redirects': page([]),
      '/admin/seo/slugs': page(SLUGS),
    });
    const manual = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ yonlendirme: 'r-8' }) })) as React.ReactElement);
    expect(manual).toContain('name="type"');
    expect(manual).toContain('value="/categories/kombi-servisi"');
  });

  it('chain, cycle and the other refusals read as the rule they broke', () => {
    expect(seoRefusalMessage({ code: 'SEO_REDIRECT_CHAIN', direction: 'TARGET_IS_SOURCE' })).toContain('zincir veya döngü');
    expect(seoRefusalMessage({ code: 'SEO_REDIRECT_CHAIN', direction: 'SOURCE_IS_TARGET' })).toContain('yönlenen başka yönlendirmeler');
    expect(seoRefusalMessage({ code: 'SEO_REDIRECT_TO_ITSELF' })).toContain('kendisine');
    expect(seoRefusalMessage({ code: 'SEO_SOURCE_IS_LIVE_PAGE' })).toContain('yayında bir sayfa');
    expect(seoRefusalMessage({ code: 'SEO_TARGET_NOT_LIVE' })).toContain('yayında bir sayfa değil');
    expect(seoRefusalMessage({ code: 'SEO_SOURCE_TAKEN' })).toContain('zaten etkin bir yönlendirme');
    expect(seoRefusalMessage({ code: 'SEO_SOURCE_RESERVED', refusal: 'RESERVED_ROUTE' })).toContain('kaynağı olamaz');
    expect(seoRefusalMessage({ code: 'SEO_PATH_INVALID', field: 'targetPath', refusal: 'ABSOLUTE_URL' })).toBe(
      'Gideceği adres tam bağlantı (https://…) değil, yalnız site içi yol yazın — örn. /categories/kombi-servisi.',
    );
    expect(seoRefusalMessage({ code: 'SEO_TARGET_NOT_CANONICAL' })).toContain('herkese açık bir sayfası');
    expect(seoRefusalMessage(null, 500)).toBe('İşlem tamamlanamadı. Tekrar deneyin.');
  });

  it('create sends what was typed; a chain refusal comes back as state', async () => {
    apiFetch.mockImplementation(async () => {
      throw new ApiError(409, JSON.stringify({ code: 'SEO_REDIRECT_CHAIN', direction: 'TARGET_IS_SOURCE' }));
    });
    const data = new FormData();
    data.set('sourcePath', 'eski-sayfa');
    data.set('targetPath', '/categories/kombi-servisi');
    data.set('type', 'TEMPORARY');
    data.set('reason', 'kampanya');
    const state = await actions.createRedirectAction({ kind: 'idle' }, data);
    expect(state).toMatchObject({ kind: 'error', code: 'SEO_REDIRECT_CHAIN' });
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({
      sourcePath: '/eski-sayfa',
      targetPath: '/categories/kombi-servisi',
      type: 'TEMPORARY',
      reason: 'kampanya',
    });
  });

  it('edit sends no source at all, and no type when the form had none', async () => {
    routes({}, {});
    const data = new FormData();
    data.set('redirectId', 'r-9');
    data.set('targetPath', '/categories/kombi-bakim');
    data.set('reason', 'yeni hedef');
    data.set('sourcePath', '/hacked');
    await expect(actions.updateRedirectAction({ kind: 'idle' }, data)).rejects.toMatchObject({ url: '/seo/redirects?ok=guncellendi' });
    expect(apiFetch.mock.calls[0]![0]).toBe('/admin/seo/redirects/r-9');
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ targetPath: '/categories/kombi-bakim', reason: 'yeni hedef' });
  });
});

// ─────────────────────────── 404 suggestions ───────────────────────────

describe('404 önerileri', () => {
  it('lists the real fields; approve and reject only with the write permission', async () => {
    routes({ '/admin/seo/not-found': page([SUGGESTION(), SUGGESTION({ id: 's-2', candidateTargetPath: null })]) });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ sekme: 'oneriler' }) })) as React.ReactElement);
    expect(out).toContain('/categories/kombi-tamir');
    expect(out).toContain('Kategori adresi');
    expect(out).toContain('4 farklı gün');
    expect(out).toContain('Öneri yok — hedef elle seçilir');
    expect(out).not.toContain('data-testid="seo-suggestion-approve"');
    expect(out).not.toContain('data-testid="seo-suggestion-reject"');

    held.add('SEO_REDIRECTS_WRITE');
    const writer = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ sekme: 'oneriler' }) })) as React.ReactElement);
    expect(writer.match(/data-testid="seo-suggestion-approve"/g)).toHaveLength(2);
    expect(writer.match(/data-testid="seo-suggestion-reject"/g)).toHaveLength(2);
    expect(read('app/seo/redirects/page.tsx')).toMatch(/<ConfirmDialog\s+proof="seo.suggestion-reject"\s+triggerLabel="Reddet"/);
    expect(read('app/seo/redirects/redirect-form.tsx')).toMatch(/<ConfirmDialog\s+proof="seo.suggestion-approve"/);
  });

  it('an empty queue says so', async () => {
    routes({ '/admin/seo/not-found': page([]) });
    const out = html((await SeoRedirectsPage({ searchParams: Promise.resolve({ sekme: 'oneriler' }) })) as React.ReactElement);
    expect(out).toContain('Henüz inceleme bekleyen 404 önerisi yok.');
  });

  it('the approve window starts on the candidate, 301, with the path fixed', async () => {
    held.add('SEO_REDIRECTS_WRITE');
    routes({ '/admin/seo/not-found': page([SUGGESTION()]), '/admin/seo/slugs': page(SLUGS) });
    const out = html(
      (await SeoRedirectsPage({ searchParams: Promise.resolve({ sekme: 'oneriler', oneri: 's-1' }) })) as React.ReactElement,
    );
    expect(out).toContain('data-testid="seo-suggestion-dialog"');
    expect(out).toContain('value="/categories/kombi-servisi"');
    expect(out).toMatch(/data-testid="seo-redirect-type-301" name="type" checked=""/);
    expect(out).toContain('data-testid="seo-redirect-source-locked"');
  });

  it('approving sends the chosen target, type and reason; nothing is approved without the press', async () => {
    const { issueConfirmationProof } = await import('../lib/confirmation-proof-server');
    routes({}, {});
    const data = new FormData();
    data.set('suggestionId', 's-1');
    data.set('targetPath', '/categories/kombi-servisi');
    data.set('type', 'PERMANENT');
    data.set('reason', '');
    expect(await actions.approveSuggestionAction({ kind: 'idle' }, data)).toMatchObject({ kind: 'error' });
    expect(apiFetch).not.toHaveBeenCalled();
    data.set('__confirmationProof', (await issueConfirmationProof('seo.suggestion-approve'))!);
    await expect(actions.approveSuggestionAction({ kind: 'idle' }, data)).rejects.toMatchObject({
      url: '/seo/redirects?sekme=oneriler&ok=onaylandi',
    });
    expect(JSON.parse(apiFetch.mock.calls[0]![1].body)).toEqual({ targetPath: '/categories/kombi-servisi', type: 'PERMANENT' });
  });
});

// ─────────────────────────── the category ───────────────────────────

describe('the category’s "Arama motoru" tab', () => {
  it('shows the API’s verdict with its numbers, and the form with the counters for a writer', () => {
    const out = html(<CategorySeoSection content={CONTENT} canWrite />);
    expect(out).toContain('Aramaya kapalı');
    expect(out).toContain('400 karakter gerek · şu an 217 karakter');
    expect(out).toContain('Fiyatı etkileyen faktörler çok kısa');
    expect(out).toMatch(/data-testid="category-seo-title-count">13 \/ 70/);
    expect(out).toMatch(/data-testid="category-seo-description-count">0 \/ 160/);
    expect(out).toMatch(/data-testid="category-seo-faq-count">1 \/ 20/);
    for (const field of ['category-seo-title', 'category-seo-description', 'category-seo-guide', 'category-seo-factors']) {
      expect(out).toContain(`data-testid="${field}"`);
    }
    expect(out.match(/data-testid="category-seo-faq-row"/g)).toHaveLength(1);
    expect(out).toContain('data-testid="category-seo-faq-remove"');
    expect(out).toContain('data-testid="category-seo-faq-add"');
    // No public preview of its own.
    expect(out).not.toMatch(/önizleme|preview/i);
  });

  it('an empty FAQ says what it costs; twenty rows close "Soru ekle"', () => {
    const empty = html(<CategorySeoSection content={{ ...CONTENT, editorialFaq: null }} canWrite />);
    expect(empty).toContain('data-testid="category-seo-faq-empty"');
    const full = html(
      <CategorySeoSection
        content={{ ...CONTENT, editorialFaq: Array.from({ length: 20 }, (_, index) => ({ question: `S${index}`, answer: 'C' })) }}
        canWrite
      />,
    );
    expect(full).toMatch(/disabled=""[^>]*data-testid="category-seo-faq-add"/);
    expect(full).toContain('En fazla 20 soru eklenebilir.');
  });

  it('SEO_READ alone reads the same content, with no form', () => {
    const out = html(<CategorySeoSection content={CONTENT} canWrite={false} />);
    expect(out).toContain('data-testid="category-seo-readonly"');
    expect(out).not.toContain('data-testid="category-seo-form"');
    expect(out).toContain('Ne kadar sürer?');
  });

  it('the tab is drawn with SEO_READ and the content saved with SEO_CONTENT_WRITE', () => {
    const source = read('app/categories/[slug]/page.tsx');
    expect(source).toContain("const canReadSeo = can('SEO_READ');");
    expect(source).toContain("...(canReadSeo ? [{ key: 'arama-motoru', label: 'Arama motoru'");
    expect(source).toContain("canWrite={can('SEO_CONTENT_WRITE')}");
    expect(read('app/categories/seo-actions.ts')).toContain('/content`');
  });
});

describe('the category form’s address', () => {
  const CATEGORY = {
    id: 'cat-1',
    name: 'Kombi servisi',
    slug: 'kombi-servisi',
    kind: 'LEAF',
    status: 'ACTIVE',
    parentId: null,
    sortOrder: 0,
    offerCreditCost: 3,
    unlimitedPackageEligible: false,
    providerEnrollmentOpen: true,
    description: null,
    imageUrl: null,
    coverImageUrl: null,
    iconKey: null,
  } as never;

  const render = (props: { slugChangeHref: string | null; publiclyReachable: boolean }) =>
    html(
      <CategoryInfoSection
        category={CATEGORY}
        groups={[]}
        canWrite
        canChangeStatus={false}
        canUpload={false}
        updateAction={() => undefined}
        {...props}
      />,
    );

  it('is read-only — the form sends no slug — with "Adresi değiştir" to the SEO window', () => {
    const out = render({ slugChangeHref: '/seo/slugs?kategori=cat-1&geri=kategori', publiclyReachable: true });
    expect(out).not.toContain('name="slug"');
    expect(out).toContain('/categories/kombi-servisi');
    expect(out).toContain('href="/seo/slugs?kategori=cat-1&amp;geri=kategori"');
    expect(out).toContain('Adres değiştiğinde eski adres otomatik olarak yeni adrese 301 ile yönlendirilir.');
  });

  it('the old warning is gone; a non-public category is told it gets no redirect', () => {
    const out = render({ slugChangeHref: null, publiclyReachable: false });
    expect(out).not.toMatch(/bağlantılar kırılır/);
    expect(out).toContain('yönlendirme oluşturulmaz');
    expect(out).not.toContain('data-testid="category-slug-change"');
    for (const file of ['app/categories/[slug]/category-sections.tsx', 'app/categories/new/page.tsx', 'app/categories/category-gates.tsx']) {
      expect(read(file), file).not.toMatch(/bağlantılar kırılır|kırılabilir/);
    }
  });
});
