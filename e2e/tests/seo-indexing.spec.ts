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
 * SEO-001: what a crawler is told, on three stacks that share one API.
 *
 *   seoProductionWebRuntime   APP_ENVIRONMENT=production + a public origin —
 *                             the only stack that may say `index`
 *   turnstileClosedWebRuntime APP_ENVIRONMENT=staging — closed
 *   primaryRuntime            APP_ENVIRONMENT=local — closed
 *
 * Everything asserted here is read from the served HTML and the two text
 * routes: the robots meta, the canonical link, the Open Graph URL, the JSON-LD
 * blocks, `robots.txt` and `sitemap.xml`. No form is filled — the production
 * stack has no Turnstile site key and its forms are closed by design.
 */

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

test.describe('SEO: production-like web (APP_ENVIRONMENT=production + public origin)', () => {
  test('the six public surfaces are indexable, canonical, and carry only verifiable JSON-LD', async ({ browser }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const home = await headOf(visitor, '/');
      expect(home.robots).toBe('index, follow');
      // Next prints the root without its trailing slash (`trailingSlash: false`);
      // `https://host` and `https://host/` are one URL to a crawler.
      expect(home.canonical).toBe(SEO_PRODUCTION_ORIGIN);
      expect(home.ogUrl).toBe(home.canonical);
      expect(home.title).toBe('TakTic — Yerel hizmet teklifleri, adil teklif kredisi');
      expect(home.ogTitle).toBe(home.title);
      expect(home.twitterTitle).toBe(home.title);
      expect(home.jsonLd.map((block) => (block as { '@type': string })['@type']).sort()).toEqual(['Organization', 'WebSite']);
      expect(home.jsonLd).toContainEqual(
        expect.objectContaining({ '@type': 'Organization', name: 'TakTick', url: `${SEO_PRODUCTION_ORIGIN}/` }),
      );
      expectCleanJsonLd(home.jsonLd);

      const catalogue = await headOf(visitor, '/categories');
      expect(catalogue.robots).toBe('index, follow');
      expect(catalogue.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/categories`);
      expect(catalogue.title).toBe('Hizmet kategorileri · TakTick');

      const category = await headOf(visitor, `/categories/${stage.category.slug}`);
      expect(category.robots).toBe('index, follow');
      expect(category.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.category.slug}`);
      expect(category.ogUrl).toBe(category.canonical);
      expect(category.title).toBe(`${stage.category.name} · TakTick`);
      // The description is the operator's text with its markup stripped.
      expect(category.description).toBe('Klima bakımı ve montaj için teklif toplayın.');
      expect(category.jsonLd.map((block) => (block as { '@type': string })['@type']).sort()).toEqual(['BreadcrumbList', 'Service']);
      expect(category.jsonLd).toContainEqual(
        expect.objectContaining({ '@type': 'Service', name: stage.category.name, url: category.canonical }),
      );
      expectCleanJsonLd(category.jsonLd);

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

      const card = await headOf(visitor, `/vitrin/${stage.cardId}`);
      expect(card.robots).toBe('index, follow');
      expect(card.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/vitrin/${stage.cardId}`);
      expect(card.ogUrl).toBe(card.canonical);
      expect(card.jsonLd).toHaveLength(1);
      expect(card.jsonLd[0]).toMatchObject({ '@type': 'Service', url: card.canonical, provider: { '@type': 'LocalBusiness' } });
      expectCleanJsonLd(card.jsonLd);
      // The card's listed price is on the page; it is not in the structured data.
      expect(JSON.stringify(card.jsonLd)).not.toMatch(/1500|1\.500|150000/);
    } finally {
      await visitor.close();
    }
  });

  test('a tracking parameter keeps the clean canonical; a functional one is noindex with no canonical', async ({ browser }) => {
    const stage = await seedStage();
    const visitor = await Actor.open(browser, 'web', seoProductionWebRuntime);

    try {
      const campaign = await headOf(visitor, `/categories/${stage.category.slug}?utm_source=news&fbclid=abc`);
      expect(campaign.robots).toBe('index, follow');
      expect(campaign.canonical).toBe(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.category.slug}`);

      const homeCampaign = await headOf(visitor, '/?utm_campaign=x');
      expect(homeCampaign.canonical).toBe(SEO_PRODUCTION_ORIGIN);

      for (const path of [
        '/categories?q=klima',
        `/categories/${stage.category.slug}?entry=${stage.category.slug}`,
        `/isletme/${stage.provider.id}?cursor=abc`,
        '/vitrin?il=%C4%B0stanbul',
        `/vitrin/${stage.cardId}?step=form`,
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

  test('sitemap.xml lists exactly the live public records, and every URL in it answers 200', async ({ request }) => {
    const stage = await seedStage();

    const sitemap = await fetchText(request, seoProductionWebRuntime, '/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toContain('xml');
    const urls = Array.from(sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)).map((match) => match[1]!);

    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/categories`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.category.slug}`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.provider.id}`);
    expect(urls).toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${stage.cardId}`);

    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${stage.draftCategory.slug}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/isletme/${stage.pendingProvider.id}`);
    expect(urls).not.toContain(`${SEO_PRODUCTION_ORIGIN}/vitrin/${stage.expiredCardId}`);

    for (const url of urls) {
      expect(url, url).toMatch(new RegExp(`^${SEO_PRODUCTION_ORIGIN.replace('.', '\\.')}/`));
      expect(url, url).not.toMatch(/[?#]/);
      expect(url, url).not.toMatch(/\/(providers|requests|account|login|register|api|mesajlar|destek)(\/|$)/);
    }

    // The category's real updatedAt travels; the static rows carry no date.
    const categoryRow = await prisma().serviceCategory.findUniqueOrThrow({ where: { id: stage.category.id }, select: { updatedAt: true } });
    const escapedOrigin = SEO_PRODUCTION_ORIGIN.replace(/\./g, '\\.');
    expect(sitemap.body).toMatch(
      new RegExp(`<loc>${escapedOrigin}/categories/${stage.category.slug}</loc>\\s*<lastmod>${categoryRow.updatedAt.toISOString()}</lastmod>`),
    );
    expect(sitemap.body).toMatch(new RegExp(`<loc>${escapedOrigin}/</loc>\\s*</url>`));

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
