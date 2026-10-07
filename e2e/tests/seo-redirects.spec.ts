import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createAdmin, createCategory, prisma, uniqueSuffix } from '../src/fixtures';
import { SEO_PRODUCTION_ORIGIN, primaryRuntime, seoProductionWebRuntime } from '../src/runtime';

/**
 * SEO-004 public smoke: a category slug change and a manual redirect, as a
 * crawler meets them on the production-declared web stack.
 *
 *   old address  → a real 301 to the new canonical (query dropped)
 *   new address  → 200, canonical = the new address
 *   sitemap.xml  → the new address, never the old
 *   manual 302   → a real 302
 *
 * The web serves redirects from a snapshot it refreshes every minute, so the
 * first answer for a fresh redirect is polled for rather than assumed.
 */

function eligibleText(chars: number, salt: string): string {
  const sentence = 'Kadıköy ve çevresinde on yılı aşkın süredir kombi bakımı ve arıza onarımı yapıyoruz. ';
  let text = `${salt}. `;
  while (text.replace(/[^\p{L}\p{N}]/gu, '').length < chars) text += sentence;
  return text.trim();
}

/** A signed-in super admin for the API, as a cookie header — the session row is written directly. */
async function adminCookie(): Promise<string> {
  const admin = await createAdmin();
  const id = `e2e-seo-${randomUUID()}`;
  await prisma().session.create({ data: { id, userId: admin.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  return `taktic_session=${id}`;
}

async function head(request: APIRequestContext, path: string) {
  const response = await request.get(`${seoProductionWebRuntime.webUrl}${path}`, { maxRedirects: 0 });
  return { status: response.status(), location: response.headers()['location'] ?? null, body: await response.text() };
}

async function eventually(request: APIRequestContext, path: string, status: number) {
  await expect
    .poll(async () => (await head(request, path)).status, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
    .toBe(status);
  return head(request, path);
}

test.describe('SEO-004: redirects as a crawler meets them', () => {
  test('a public category’s slug change: 301 from the old address, 200 and canonical on the new, sitemap follows', async ({ request }) => {
    const category = await createCategory(3, { namePrefix: 'SEO Kombi' });
    await prisma().serviceCategory.update({
      where: { id: category.id },
      data: {
        description: eligibleText(400, 'Açıklama'),
        editorialDecisionGuide: eligibleText(80, 'Rehber'),
        editorialPriceFactors: eligibleText(80, 'Fiyat'),
        editorialFaq: [{ question: 'Bakım ne kadar sürer?', answer: eligibleText(80, 'Cevap') }],
        seoTitle: 'Kombi Bakımı — Teklif Al',
      },
    });
    const newSlug = `seo-kombi-yeni-${uniqueSuffix()}`;
    const cookie = await adminCookie();

    const changed = await request.post(`${primaryRuntime.apiUrl}/admin/seo/categories/${category.id}/slug`, {
      headers: { cookie },
      data: { slug: newSlug },
    });
    expect(changed.status()).toBe(200);
    expect((await changed.json()).redirect).toMatchObject({ status: 301, origin: 'SLUG_CHANGE' });

    const old = await eventually(request, `/categories/${category.slug}?utm_source=x`, 301);
    expect(old.location).toBe(`${SEO_PRODUCTION_ORIGIN}/categories/${newSlug}`);

    const page = await head(request, `/categories/${newSlug}`);
    expect(page.status).toBe(200);
    expect(page.body.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(`${SEO_PRODUCTION_ORIGIN}/categories/${newSlug}`);
    expect(page.body.match(/<title>([^<]*)<\/title>/)?.[1]).toBe('Kombi Bakımı — Teklif Al');
    expect(page.body).toContain('Nasıl seçilir?');
    expect(page.body).not.toContain('FAQPage');

    const sitemap = await request.get(`${seoProductionWebRuntime.webUrl}/sitemap.xml`);
    const locs = Array.from((await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)).map((match) => match[1]!);
    expect(locs).toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${newSlug}`);
    expect(locs).not.toContain(`${SEO_PRODUCTION_ORIGIN}/categories/${category.slug}`);
  });

  test('a manual temporary redirect answers a real 302; an unknown address stays a 404', async ({ request }) => {
    const cookie = await adminCookie();
    const source = `/eski-kampanya-${uniqueSuffix()}`;
    const created = await request.post(`${primaryRuntime.apiUrl}/admin/seo/redirects`, {
      headers: { cookie },
      data: { sourcePath: source, targetPath: '/vitrin', type: 'TEMPORARY', reason: 'kampanya bitti' },
    });
    expect(created.status()).toBe(201);

    const answer = await eventually(request, source, 302);
    expect(answer.location).toBe(`${SEO_PRODUCTION_ORIGIN}/vitrin`);

    // A stack that names no public origin (the primary one, like a local
    // dev stack) still answers a real redirect: an absolute Location on its
    // own origin — Next refuses a relative one with a 500 — never cached.
    await expect
      .poll(async () => (await request.get(`${primaryRuntime.webUrl}${source}`, { maxRedirects: 0 })).status(), {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(302);
    const local = await request.get(`${primaryRuntime.webUrl}${source}`, { maxRedirects: 0 });
    // Next names the server's own host (`localhost` for 127.0.0.1); what
    // matters is an absolute URL on this server, at the target.
    const location = new URL(local.headers()['location']!);
    const self = new URL(primaryRuntime.webUrl);
    expect([location.protocol, location.port, location.pathname, location.search]).toEqual([self.protocol, self.port, '/vitrin', '']);
    expect(local.headers()['cache-control']).toBe('no-store');

    expect((await head(request, `/eski-kampanya-yok-${uniqueSuffix()}`)).status).toBe(404);
  });
});
