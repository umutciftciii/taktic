import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Actor, assertNoErrorScreen } from '../src/actors';
import {
  createCategory,
  createProvider,
  prisma,
  uniqueLocation,
  uniqueSuffix,
  type SeededCategory,
  type SeededProvider,
} from '../src/fixtures';
import {
  SEO_PRODUCTION_ORIGIN,
  primaryRuntime,
  seoProductionWebRuntime,
  turnstileClosedWebRuntime,
  type Runtime,
} from '../src/runtime';
import {
  retireShowcasePlacements,
  seedApprovedShowcaseCard,
  seedLiveShowcasePlacement,
} from '../src/showcase-fixtures';

/**
 * SEO-001 + SEO-003: what a crawler is told, on three stacks that share one API.
 *
 *   seoProductionWebRuntime   APP_ENVIRONMENT=production + a public origin —
 *                             the only stack that may say `index`
 *   turnstileClosedWebRuntime APP_ENVIRONMENT=staging — closed
 *   primaryRuntime            APP_ENVIRONMENT=local — closed
 *
 * On the open stack a public page is indexed only when the record behind it
 * is index-eligible (SEO-003): the API's `seoIndexable`, the one rule the
 * sitemap lists by. Two stages are seeded below — one of everything public
 * but thin (`seedStage`, what today's real inventory looks like) and one of
 * everything eligible (`seedEligibleStage`) — and the two are told apart by
 * their `<head>` and by the sitemap alone. A category is never eligible yet:
 * the editorial blocks it would need have no column (B4).
 *
 * Everything asserted here is read from the served HTML and the two text
 * routes: the robots meta, the canonical link, the Open Graph URL, the JSON-LD
 * blocks, `robots.txt` and `sitemap.xml`. No form is filled — the production
 * stack has no Turnstile site key and its forms are closed by design.
 */

/** Meaningful letters only — no whitespace or punctuation doing the counting. */
function eligibleText(chars: number, salt: string): string {
  const sentence = 'Kadıköy ve çevresinde on yılı aşkın süredir klima bakımı, montajı ve arıza onarımı yapıyoruz. ';
  let text = `${salt}. `;
  while (text.replace(/[^\p{L}\p{N}]/gu, '').length < chars) text += sentence;
  return text.trim();
}

const ELIGIBLE_PROVIDER_DESCRIPTION_CHARS = 300;
const ELIGIBLE_CARD_SUMMARY_CHARS = 200;
const ELIGIBLE_SHELF_CARDS = 5;
const ELIGIBLE_SCOPE = {
  scopeIncluded: ['Filtre temizliği', 'Gaz basıncı kontrolü', 'Drenaj hattı kontrolü'],
  scopeExcluded: ['Gaz dolumu'],
};

/** A `noindex, follow` page that names nothing: no canonical, no og:url, no JSON-LD. */
function expectClosedPublicPage(head: Head, path: string) {
  expect(head.robots, path).toBe('noindex, follow');
  expect(head.canonical, path).toBeNull();
  expect(head.ogUrl, path).toBeNull();
  expect(head.jsonLd, path).toEqual([]);
}

const placementsOnAir: string[] = [];

test.afterEach(async () => {
  await retireShowcasePlacements(placementsOnAir.splice(0));
});

type Head = {
  title: string | null;
  robots: string | null;
  canonical: string | null;
  ogUrl: string | null;
  ogTitle: string | null;
  twitterTitle: string | null;
  description: string | null;
  jsonLd: unknown[];
};

async function readHead(page: Page): Promise<Head> {
  return page.evaluate(() => {
    const meta = (name: string, attribute: 'name' | 'property') =>
      document.querySelector(`meta[${attribute}="${name}"]`)?.getAttribute('content') ?? null;
    return {
      title: document.title || null,
      robots: meta('robots', 'name'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogUrl: meta('og:url', 'property'),
      ogTitle: meta('og:title', 'property'),
      twitterTitle: meta('twitter:title', 'name'),
      description: meta('description', 'name'),
      jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((node) =>
        JSON.parse(node.textContent ?? 'null'),
      ),
    };
  });
}

async function headOf(visitor: Actor, path: string): Promise<Head> {
  await visitor.gotoWeb(path);
  await assertNoErrorScreen(visitor.page);
  return readHead(visitor.page);
}

/** Keys no JSON-LD block on this site may carry. */
const FORBIDDEN_JSON_LD_KEYS = ['aggregateRating', 'review', 'offers', 'price', 'priceRange', 'telephone', 'email', 'areaServed'];

function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      keysOf(inner, found);
    }
  }
  return found;
}

function expectCleanJsonLd(blocks: unknown[]) {
  const keys = keysOf(blocks);
  for (const key of FORBIDDEN_JSON_LD_KEYS) expect(keys, key).not.toContain(key);
}

async function fetchText(request: APIRequestContext, runtime: Runtime, path: string) {
  const response = await request.get(`${runtime.webUrl}${path}`);
  return { status: response.status(), body: await response.text(), headers: response.headers() };
}

type Stage = {
  category: SeededCategory;
  provider: SeededProvider;
  cardId: string;
  draftCategory: SeededCategory;
  pendingProvider: SeededProvider;
  expiredCardId: string;
};

/**
 * One of everything the sitemap may list, and one of everything it may not:
 * a live category, business and card beside a DRAFT category, a
 * PENDING_REVIEW business and a card whose run has ended.
 */
async function seedStage(): Promise<Stage> {
  const location = uniqueLocation();
  const category = await createCategory(3, {
    namePrefix: 'E2E SEO Klima',
    description: 'Klima bakımı ve <b>montaj</b> için teklif toplayın.',
  });
  const provider = await createProvider({ categoryId: category.id, location, credits: 0 });
  const { card, version } = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `E2E SEO Vitrin ${uniqueSuffix()}`,
  });
  const { placement } = await seedLiveShowcasePlacement({
    providerId: provider.id,
    cardId: card.id,
    versionId: version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  placementsOnAir.push(placement.id);

  const draftCategory = await createCategory(3, { namePrefix: 'E2E SEO Taslak', status: 'DRAFT' });
  const pendingProvider = await createProvider({ categoryId: category.id, location: uniqueLocation(), credits: 0 });
  await prisma().providerProfile.update({ where: { id: pendingProvider.id }, data: { status: 'PENDING_REVIEW' } });

  const expired = await seedApprovedShowcaseCard({
    providerId: provider.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
    title: `E2E SEO Süresi Bitmiş ${uniqueSuffix()}`,
  });
  const expiredRun = await seedLiveShowcasePlacement({
    providerId: provider.id,
    cardId: expired.card.id,
    versionId: expired.version.id,
    categoryId: category.id,
    city: location.city,
    district: location.district,
  });
  await retireShowcasePlacements([expiredRun.placement.id]);

  return { category, provider, cardId: card.id, draftCategory, pendingProvider, expiredCardId: expired.card.id };
}

type EligibleStage = {
  category: SeededCategory;
  provider: SeededProvider;
  cardIds: string[];
};

/**
 * A business that clears the profile rule and enough of its cards clearing
 * the card rule to make the shelf a list — each with a summary of its own,
 * because a copied summary is not a page.
 */
async function seedEligibleStage(): Promise<EligibleStage> {
  const location = uniqueLocation();
  const suffix = uniqueSuffix();
  // Letters only inside the texts the JSON-LD prints, so a digit run in the
  // suffix can never look like the listed price the assertions search for.
  const wordSuffix = suffix.replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)]!);
  const category = await createCategory(3, {
    namePrefix: 'E2E SEO Uygun',
    description: 'Klima bakımı için teklif toplayın.',
  });
  const provider = await createProvider({
    categoryId: category.id,
    location,
    credits: 0,
    description: eligibleText(ELIGIBLE_PROVIDER_DESCRIPTION_CHARS, `İşletme ${wordSuffix}`),
  });

  const cardIds: string[] = [];
  for (let index = 0; index < ELIGIBLE_SHELF_CARDS; index += 1) {
    const { card, version } = await seedApprovedShowcaseCard({
      providerId: provider.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
      title: `E2E SEO Uygun Kart ${suffix} ${index + 1}`,
      summary: eligibleText(ELIGIBLE_CARD_SUMMARY_CHARS, `Kart ${wordSuffix} ${'abcde'[index]}`),
      ...ELIGIBLE_SCOPE,
    });
    const { placement } = await seedLiveShowcasePlacement({
      providerId: provider.id,
      cardId: card.id,
      versionId: version.id,
      categoryId: category.id,
      city: location.city,
      district: location.district,
    });
    placementsOnAir.push(placement.id);
    cardIds.push(card.id);
  }

  return { category, provider, cardIds };
}

test.describe('SEO: production-like web (APP_ENVIRONMENT=production + public origin)', () => {
  test('today\'s inventory: the home page and the catalogue are indexed; a thin category, business, shelf and card are public but noindex', async ({ browser }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const home = await headOf(visitor, '/');
      expect(home.robots).toBe('index, follow');
      // The canonical standard: origin + path, no trailing slash, and the root
      // is the bare origin. The same bytes on og:url, in the JSON-LD and in
      // the sitemap (checked against the sitemap below).
      expect(home.canonical).toBe(SEO_PRODUCTION_ORIGIN);
      expect(home.ogUrl).toBe(home.canonical);
      expect(home.jsonLd).toContainEqual(expect.objectContaining({ '@type': 'WebSite', url: home.canonical }));
      expect(home.title).toBe('TakTic — Yerel hizmet teklifleri, adil teklif kredisi');
      expect(home.ogTitle).toBe(home.title);
      expect(home.twitterTitle).toBe(home.title);
      expect(home.jsonLd.map((block) => (block as { '@type': string })['@type']).sort()).toEqual(['Organization', 'WebSite']);
      expect(home.jsonLd).toContainEqual(
        expect.objectContaining({ '@type': 'Organization', name: 'TakTick', url: SEO_PRODUCTION_ORIGIN }),
      );
      expectCleanJsonLd(home.jsonLd);

      const catalogue = await headOf(visitor, '/categories');
      expect(catalogue.robots).toBe('index, follow');
      expect(catalogue.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/categories`);
      expect(catalogue.ogUrl).toBe(catalogue.canonical);
      expect(catalogue.title).toBe('Hizmet kategorileri · TakTick');

      // Public, rendered, titled and described as before — and not indexed:
      // one sentence and a form is not a page worth a result.
      const category = await headOf(visitor, `/categories/${stage.category.slug}`);
      expectClosedPublicPage(category, `/categories/${stage.category.slug}`);
      expect(category.title).toBe(`${stage.category.name} · TakTick`);
      expect(category.description).toBe('Klima bakımı ve montaj için teklif toplayın.');
      await expect(visitor.page.getByRole('heading', { name: stage.category.name })).toBeVisible();

      // A business with a two-word "about" text.
      const business = await headOf(visitor, `/isletme/${stage.provider.id}`);
      expectClosedPublicPage(business, `/isletme/${stage.provider.id}`);
      expect(business.title).toBe(`${stage.provider.businessName} · TakTick`);
      await expect(visitor.page.getByTestId('public-provider-name')).toHaveText(stage.provider.businessName);

      // A shelf with too few indexable cards, and a card with a one-line summary.
      expectClosedPublicPage(await headOf(visitor, '/vitrin'), '/vitrin');
      const card = await headOf(visitor, `/vitrin/${stage.cardId}`);
      expectClosedPublicPage(card, `/vitrin/${stage.cardId}`);
      await expect(visitor.page.getByTestId('showcase-card-provider-link')).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('an eligible business and enough eligible cards open the business, the shelf and the cards together — and nothing else', async ({ browser, request }) => {
    const thin = await seedStage();
    const stage = await seedEligibleStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const business = await headOf(visitor, `/isletme/${stage.provider.id}`);
      expect(business.robots).toBe('index, follow');
      expect(business.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.provider.id}`);
      expect(business.ogUrl).toBe(business.canonical);
      expect(business.title).toBe(`${stage.provider.businessName} · TakTick`);
      expect(business.jsonLd).toHaveLength(1);
      expect(business.jsonLd[0]).toMatchObject({
        '@type': 'LocalBusiness',
        name: stage.provider.businessName,
        url: business.canonical,
        address: { '@type': 'PostalAddress', addressCountry: 'TR' },
      });
      expectCleanJsonLd(business.jsonLd);
      // Nothing that reaches a person, in any block.
      expect(JSON.stringify(business.jsonLd)).not.toMatch(/example\.test|\+90|05\d{2}/);

      const shelf = await headOf(visitor, '/vitrin');
      expect(shelf.robots).toBe('index, follow');
      expect(shelf.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/vitrin`);
      expect(shelf.ogUrl).toBe(shelf.canonical);

      for (const cardId of stage.cardIds) {
        const card = await headOf(visitor, `/vitrin/${cardId}`);
        expect(card.robots, cardId).toBe('index, follow');
        expect(card.canonical, cardId).toBe(`${SEO_PRODUCTION_ORIGIN}/vitrin/${cardId}`);
        expect(card.ogUrl, cardId).toBe(card.canonical);
        expect(card.jsonLd, cardId).toHaveLength(1);
        expect(card.jsonLd[0], cardId).toMatchObject({ '@type': 'Service', url: card.canonical, provider: { '@type': 'LocalBusiness' } });
        expectCleanJsonLd(card.jsonLd);
        // The card's listed price is on the page; it is not in the structured
        // data. The URL is taken out first: a card id is a random string and
        // may spell those digits by chance.
        expect(JSON.stringify(card.jsonLd).split(card.canonical!).join(''), cardId).not.toMatch(/1500|1\.500|150000/);
      }

      // The eligible category is still a category: no editorial blocks, no index.
      expectClosedPublicPage(await headOf(visitor, `/categories/${stage.category.slug}`), `/categories/${stage.category.slug}`);
      // The thin stage stays closed beside it — and its card is now on an
      // indexable shelf, which changes nothing about the card.
      expectClosedPublicPage(await headOf(visitor, `/isletme/${thin.provider.id}`), `/isletme/${thin.provider.id}`);
      expectClosedPublicPage(await headOf(visitor, `/vitrin/${thin.cardId}`), `/vitrin/${thin.cardId}`);

      // The sitemap says exactly the same: the eligible business and cards,
      // the shelf, the two static pages — not the thin ones, not the category.
      const sitemap = await fetchText(request, seoProductionWebRuntime, '/sitemap.xml');
      const urls = Array.from(sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((match) => match[1]!);
      expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.provider.id}`);
      expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin`);
      for (const cardId of stage.cardIds) expect(urls, cardId).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${cardId}`);
      expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.category.slug}`);
      expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${thin.provider.id}`);
      expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${thin.cardId}`);
    } finally {
      await visitor.close();
    }
  });

  test('one URL form everywhere: canonical = og:url = JSON-LD url = sitemap <loc>, byte for byte', async ({ browser, request }) => {
    const stage = await seedEligibleStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const sitemap = await fetchText(request, seoProductionWebRuntime, '/sitemap.xml');
      const locs = Array.from(sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((match) => match[1]!);

      // Every indexable page there is today: the two static pages and the
      // eligible stage. (No category is indexable yet — see the header.)
      const pages = [
        '/',
        '/categories',
        `/isletme/${stage.provider.id}`,
        '/vitrin',
        `/vitrin/${stage.cardIds[0]}`,
      ];
      for (const path of pages) {
        const head = await headOf(visitor, path);
        const canonical = head.canonical;
        expect(canonical, path).toBe(path === '/' ? SEO_PRODUCTION_ORIGIN : `${SEO_PRODUCTION_ORIGIN}${path}`);
        expect(canonical, path).not.toMatch(/[?#]|\/$/);
        expect(head.ogUrl, path).toBe(canonical);
        // Exactly one sitemap row is this page, and it is the same string.
        expect(locs.filter((loc) => loc === canonical), path).toHaveLength(1);
        // Every JSON-LD block that names the page names it the same way.
        for (const block of head.jsonLd as { '@type': string; url?: string }[]) {
          if (block['@type'] !== 'BreadcrumbList' && block['@type'] !== 'Organization') {
            expect(block.url, `${path} ${block['@type']}`).toBe(canonical);
          }
        }
      }

      // A trailing slash is not a second page: Next redirects it, and the
      // canonical is the clean form.
      for (const path of ['/categories/', `/isletme/${stage.provider.id}/`]) {
        await visitor.gotoWeb(path);
        expect(new URL(visitor.page.url()).pathname, path).toBe(path.slice(0, -1));
        expect((await readHead(visitor.page)).canonical, path).toBe(`${SEO_PRODUCTION_ORIGIN}${path.slice(0, -1)}`);
      }
    } finally {
      await visitor.close();
    }
  });

  test('a tracking parameter keeps the clean canonical; a functional one is noindex with no canonical', async ({ browser }) => {
    const stage = await seedEligibleStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const campaign = await headOf(visitor, `/isletme/${stage.provider.id}?utm_source=news&fbclid=abc`);
      expect(campaign.robots).toBe('index, follow');
      expect(campaign.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.provider.id}`);

      const homeCampaign = await headOf(visitor, '/?utm_campaign=x');
      expect(homeCampaign.canonical).toBe(SEO_PRODUCTION_ORIGIN);

      for (const path of [
        '/categories?q=klima',
        `/categories/${stage.category.slug}?entry=${stage.category.slug}`,
        `/isletme/${stage.provider.id}?cursor=abc`,
        '/vitrin?il=%C4%B0stanbul',
        `/vitrin/${stage.cardIds[0]}?step=form`,
      ]) {
        const head = await headOf(visitor, path);
        expect(head.robots, path).toBe('noindex, follow');
        expect(head.canonical, path).toBeNull();
        expect(head.ogUrl, path).toBeNull();
        expect(head.jsonLd, path).toEqual([]);
      }
    } finally {
      await visitor.close();
    }
  });

  test('private, auth, form and success screens are noindex even here', async ({ browser }) => {
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      for (const path of ['/login', '/register/customer', '/providers/register', '/requests/success', '/sifre-unuttum', '/sozlesmeler/iletisim-paylasimi']) {
        await visitor.gotoWeb(path);
        const head = await readHead(visitor.page);
        expect(head.robots, path).toMatch(/^noindex/);
        expect(head.canonical, path).toBeNull();
        expect(head.jsonLd, path).toEqual([]);
      }

      // A panel route redirects to sign-in; whichever screen answers is closed.
      await visitor.gotoWeb('/requests/my');
      expect((await readHead(visitor.page)).robots).toMatch(/^noindex/);

      // A 404 inherits the layout default.
      await visitor.gotoWeb('/isletme/does-not-exist');
      expect((await readHead(visitor.page)).robots).toMatch(/^noindex/);
    } finally {
      await visitor.close();
    }
  });

  test('a non-approved business and an unreleased category are closed pages', async ({ browser }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      await visitor.gotoWeb(`/isletme/${stage.pendingProvider.id}`);
      expect((await readHead(visitor.page)).robots).toMatch(/^noindex/);
      await expect(visitor.page.getByRole('heading', { name: 'Sayfa bulunamadı' })).toBeVisible();

      await visitor.gotoWeb(`/categories/${stage.draftCategory.slug}`);
      expect((await readHead(visitor.page)).robots).toMatch(/^noindex/);
      await expect(visitor.page.getByRole('heading', { name: 'Sayfa bulunamadı' })).toBeVisible();

      await visitor.gotoWeb(`/vitrin/${stage.expiredCardId}`);
      expect((await readHead(visitor.page)).robots).toMatch(/^noindex/);
      await expect(visitor.page.getByRole('heading', { name: 'Sayfa bulunamadı' })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('robots.txt allows the site, disallows the private prefixes and names the sitemap', async ({ request }) => {
    const robots = await fetchText(request, seoProductionWebRuntime, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.body).toContain('User-Agent: *');
    expect(robots.body).toContain('Allow: /');
    for (const prefix of ['/api/', '/account/', '/login', '/register/', '/requests/', '/providers/', '/mesajlar', '/destek']) {
      expect(robots.body, prefix).toContain(`Disallow: ${prefix}`);
    }
    expect(robots.body).toContain(`Sitemap: ${SEO_PRODUCTION_ORIGIN}/sitemap.xml`);
  });

  test('sitemap.xml lists exactly the index-eligible public records, and every URL in it answers 200', async ({ request }) => {
    const thin = await seedStage();
    const stage = await seedEligibleStage();

    const sitemap = await fetchText(request, seoProductionWebRuntime, '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toContain('xml');
    const urls = Array.from(sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((match) => match[1]!);

    expect(urls).toContain(SEO_PRODUCTION_ORIGIN);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/categories`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.provider.id}`);
    for (const cardId of stage.cardIds) expect(urls, cardId).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${cardId}`);

    // Public but thin: rendered, 200, and not listed.
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.category.slug}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${thin.category.slug}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${thin.provider.id}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${thin.cardId}`);
    // Not public at all: never listed either.
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${thin.draftCategory.slug}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${thin.pendingProvider.id}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${thin.expiredCardId}`);

    for (const url of urls) {
      expect(url, url).toMatch(new RegExp(`^${SEO_PRODUCTION_ORIGIN.replace('.', '\\.')}(/|$)`));
      expect(url, url).not.toMatch(/[?#]|\/$/);
      expect(url, url).not.toMatch(/\/(providers|requests|account|login|register|api|mesajlar|destek)(\/|$)/);
    }

    // The business's real updatedAt travels; the static rows and the card rows carry no date.
    const providerRow = await prisma().providerProfile.findUniqueOrThrow({ where: { id: stage.provider.id }, select: { updatedAt: true } });
    const escapedOrigin = SEO_PRODUCTION_ORIGIN.replace(/\./g, '\\.');
    expect(sitemap.body).toMatch(
      new RegExp(`<loc>${escapedOrigin}/isletme/${stage.provider.id}</loc>\\s*<lastmod>${providerRow.updatedAt.toISOString()}</lastmod>`),
    );
    expect(sitemap.body).toMatch(new RegExp(`<loc>${escapedOrigin}</loc>\\s*</url>`));
    expect(sitemap.body).toMatch(new RegExp(`<loc>${escapedOrigin}/vitrin/${stage.cardIds[0]}</loc>\\s*</url>`));

    // The one source the sitemap is built from lists the same records and no
    // other: nothing unreleased, pending or expired leaves the API either.
    const source = await request.get(`${primaryRuntime.apiUrl}/sitemap/entries`);
    expect(source.status()).toBe(200);
    expect(source.headers()['cache-control']).toBe('no-store');
    const entries = (await source.json()) as {
      categories: { slug: string; updatedAt: string }[];
      providers: { id: string; updatedAt: string }[];
      showcaseCards: { cardId: string }[];
    };
    expect(Object.keys(entries).sort()).toEqual(['categories', 'providers', 'showcaseCards']);
    // No category is eligible yet, whatever its status.
    expect(entries.categories.map((row) => row.slug)).not.toContain(stage.category.slug);
    expect(entries.categories.map((row) => row.slug)).not.toContain(thin.category.slug);
    expect(entries.categories.map((row) => row.slug)).not.toContain(thin.draftCategory.slug);
    expect(entries.providers.map((row) => row.id)).toContain(stage.provider.id);
    expect(entries.providers.map((row) => row.id)).not.toContain(thin.provider.id);
    expect(entries.providers.map((row) => row.id)).not.toContain(thin.pendingProvider.id);
    for (const cardId of stage.cardIds) expect(entries.showcaseCards.map((row) => row.cardId), cardId).toContain(cardId);
    expect(entries.showcaseCards.map((row) => row.cardId)).not.toContain(thin.cardId);
    expect(entries.showcaseCards.map((row) => row.cardId)).not.toContain(thin.expiredCardId);
    // Identifiers only: no name, city, title, price, contact detail — and
    // nothing the eligibility rule read (the description, the scope).
    expect(JSON.stringify(entries)).not.toMatch(new RegExp(stage.provider.businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(JSON.stringify(entries)).not.toMatch(/example\.test|İşletme|Vitrin|1500|150000|Filtre|klima bakımı/);
    // The page and the source agree, record by record.
    for (const [path, expected] of [
      [`/providers/${stage.provider.id}`, true],
      [`/providers/${thin.provider.id}`, false],
      [`/showcase/cards/${stage.cardIds[0]}`, true],
      [`/showcase/cards/${thin.cardId}`, false],
      [`/categories/${stage.category.slug}`, false],
    ] as const) {
      const page = await request.get(`${primaryRuntime.apiUrl}${path}`);
      expect(page.status(), path).toBe(200);
      expect(((await page.json()) as { seoIndexable?: boolean }).seoIndexable, path).toBe(expected);
    }
    expect(((await (await request.get(`${primaryRuntime.apiUrl}/showcase/feed`)).json()) as { seoIndexable?: boolean }).seoIndexable).toBe(true);
    // The sitemap has one row per dynamic record the source names, and no more.
    const dynamicRows = urls.filter((url) => /\/(categories|isletme|vitrin)\/./.test(url));
    expect(dynamicRows).toHaveLength(entries.categories.length + entries.providers.length + entries.showcaseCards.length);
    // Read-only, and only this path.
    expect((await request.post(`${primaryRuntime.apiUrl}/sitemap/entries`, { data: {} })).status()).toBe(404);
    expect((await request.get(`${primaryRuntime.apiUrl}/providers/public-directory`)).status()).toBe(404);

    // Every listed page is a page: fetched on the test host, all answer 200.
    for (const url of urls) {
      const path = url.slice(SEO_PRODUCTION_ORIGIN.length);
      const page = await fetchText(request, seoProductionWebRuntime, path);
      expect(page.status, url).toBe(200);
    }
  });
});

test.describe('SEO: staging-like and local web stacks are closed', () => {
  test('staging: noindex everywhere, no canonical, robots disallows all, sitemap is empty', async ({ browser, request }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', turnstileClosedWebRuntime);

    try {
      for (const path of ['/', `/categories/${stage.category.slug}`, `/isletme/${stage.provider.id}`, `/vitrin/${stage.cardId}`]) {
        const head = await headOf(visitor, path);
        expect(head.robots, path).toBe('noindex, nofollow');
        expect(head.canonical, path).toBeNull();
        expect(head.ogUrl, path).toBeNull();
        expect(head.jsonLd, path).toEqual([]);
      }
    } finally {
      await visitor.close();
    }

    const robots = await fetchText(request, turnstileClosedWebRuntime, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.body).toContain('Disallow: /');
    expect(robots.body).not.toContain('Allow: /');
    expect(robots.body).not.toContain('Sitemap:');

    const sitemap = await fetchText(request, turnstileClosedWebRuntime, '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.body).not.toContain('<loc>');
  });

  test('local: the home page and a category are noindex', async ({ browser, request }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', primaryRuntime);

    try {
      expect((await headOf(visitor, '/')).robots).toBe('noindex, nofollow');
      const category = await headOf(visitor, `/categories/${stage.category.slug}`);
      expect(category.robots).toBe('noindex, nofollow');
      expect(category.canonical).toBeNull();
    } finally {
      await visitor.close();
    }

    const robots = await fetchText(request, primaryRuntime, '/robots.txt');
    expect(robots.body).toContain('Disallow: /');
    expect(robots.body).not.toContain('Sitemap:');
  });
});
