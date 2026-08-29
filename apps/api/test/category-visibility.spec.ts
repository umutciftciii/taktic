import {
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createSelectQuestion,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Who may read an unreleased category.
 *
 * `includeInactive=true` is the operator's view of the taxonomy — every DRAFT
 * service the marketplace is preparing, every category it has closed, the
 * groups and routers that are navigation rather than services, and the
 * questions and routing destinations behind all of them. It used to be a plain
 * query parameter on two public endpoints, which made the whole unreleased
 * catalogue readable by anybody who typed it.
 *
 * These cases pin the access matrix down at the HTTP boundary, because the
 * claim is about what a stranger can fetch — not about what a service method
 * returns when a caller passes it the right boolean.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'taktic_session';

async function cookieFor(role: UserRole) {
  const user = await createUser(ctx.prisma, { role });
  return loginAs(ctx.prisma, user.id);
}

/**
 * One unreleased service, with a question on it, plus the shapes that are
 * public. Every leak assertion below is about the first three never appearing
 * anywhere in a response body.
 */
async function unreleasedFixture() {
  const draft = await createCategory(ctx.prisma, 'Gizli Taslak Hizmet', {
    status: ServiceCategoryStatus.DRAFT,
  });
  const draftQuestion = await createSelectQuestion(ctx.prisma, {
    categoryId: draft.id,
    key: 'gizli_soru',
    label: 'Yayınlanmamış hizmetin sorusu',
    options: [{ key: 'a', label: 'A' }],
  });
  const closed = await createCategory(ctx.prisma, 'Kapatılmış Hizmet', {
    status: ServiceCategoryStatus.INACTIVE,
  });
  const group = await createCategory(ctx.prisma, 'Grup', {
    kind: ServiceCategoryKind.GROUP,
  });
  const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 1 });

  return { draft, draftQuestion, closed, group, live };
}

/** Nothing about the unreleased taxonomy may appear in `body`, anywhere. */
function expectNoDraftLeak(
  body: unknown,
  fixture: Awaited<ReturnType<typeof unreleasedFixture>>,
) {
  const serialized = JSON.stringify(body ?? null);

  expect(serialized).not.toContain(fixture.draft.slug);
  expect(serialized).not.toContain(fixture.draft.name);
  expect(serialized).not.toContain(fixture.draftQuestion.key);
  expect(serialized).not.toContain(fixture.draftQuestion.label);
  expect(serialized).not.toContain(fixture.closed.slug);
  expect(serialized).not.toContain(fixture.group.slug);
  expect(serialized).not.toContain(ServiceCategoryStatus.DRAFT);
}

describe('GET /categories?includeInactive=true', () => {
  it('refuses an anonymous caller and leaks nothing in the refusal', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .expect(403);

    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a signed-in CUSTOMER', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.CUSTOMER))
      .expect(403);

    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a signed-in PROVIDER', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.PROVIDER))
      .expect(403);

    expectNoDraftLeak(response.body, fixture);
  });

  it('serves the whole tree to a SUPER_ADMIN', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
      .expect(200);

    const slugs = response.body.map((category: { slug: string }) => category.slug);

    expect(slugs).toContain(fixture.draft.slug);
    expect(slugs).toContain(fixture.closed.slug);
    expect(slugs).toContain(fixture.group.slug);
    expect(slugs).toContain(fixture.live.slug);
  });

  it('is the query string that is refused, not the search behind it', async () => {
    // The same request without the elevation is the public catalogue and stays
    // open — a 403 here would have broken every visitor's category page.
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get(`/categories?q=${encodeURIComponent('Hizmet')}`)
      .expect(200);

    expect(response.body.map((category: { slug: string }) => category.slug)).toEqual([
      fixture.live.slug,
    ]);
    expectNoDraftLeak(response.body, fixture);
  });
});

describe('GET /categories/:slug?includeInactive=true', () => {
  it('refuses an anonymous caller', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get(`/categories/${fixture.draft.slug}?includeInactive=true`)
      .expect(403);

    expectNoDraftLeak(response.body, fixture);
  });

  it('refuses a CUSTOMER and a PROVIDER', async () => {
    const fixture = await unreleasedFixture();

    for (const role of [UserRole.CUSTOMER, UserRole.PROVIDER]) {
      const response = await request(ctx.server)
        .get(`/categories/${fixture.draft.slug}?includeInactive=true`)
        .set('Cookie', await cookieFor(role))
        .expect(403);

      expectNoDraftLeak(response.body, fixture);
    }
  });

  it('refuses before it looks the slug up, so it cannot confirm one exists', async () => {
    const fixture = await unreleasedFixture();

    const existing = await request(ctx.server)
      .get(`/categories/${fixture.draft.slug}?includeInactive=true`)
      .expect(403);
    const imaginary = await request(ctx.server)
      .get('/categories/bu-slug-hicbir-zaman-var-olmadi?includeInactive=true')
      .expect(403);

    expect(existing.body).toEqual(imaginary.body);
  });

  it('serves the draft and its questions to a SUPER_ADMIN', async () => {
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get(`/categories/${fixture.draft.slug}?includeInactive=true`)
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
      .expect(200);

    expect(response.body).toMatchObject({
      slug: fixture.draft.slug,
      status: ServiceCategoryStatus.DRAFT,
      isActive: false,
    });
    expect(response.body.questions).toHaveLength(1);
    expect(response.body.questions[0].key).toBe(fixture.draftQuestion.key);
  });

  it('still hides a draft behind a 404 when nobody asked to be elevated', async () => {
    const fixture = await unreleasedFixture();

    // Unchanged, and deliberately not a 403: guessing the slug of an unreleased
    // service must not confirm that it exists.
    await request(ctx.server).get(`/categories/${fixture.draft.slug}`).expect(404);
  });
});

describe('a credential that could not be resolved', () => {
  /*
   * A session cookie is this API's credential. One that resolves to no user —
   * expired, revoked, forged — is not the same thing as no cookie at all, and
   * answering it as though the caller had asked anonymously is how a client
   * discovers its session died as a "wrong answer" rather than as a sign-in
   * prompt. AuthGuard says 401 to that request everywhere else; so does this.
   */
  it('answers 401 on the list, not 403', async () => {
    await unreleasedFixture();

    await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', `${COOKIE_NAME}=bu-oturum-hicbir-zaman-var-olmadi`)
      .expect(401);
  });

  it('answers 401 on the detail, not 403', async () => {
    const fixture = await unreleasedFixture();

    await request(ctx.server)
      .get(`/categories/${fixture.draft.slug}?includeInactive=true`)
      .set('Cookie', `${COOKIE_NAME}=bu-oturum-hicbir-zaman-var-olmadi`)
      .expect(401);
  });

  it('answers 401 to a bearer token, which this API has no scheme for', async () => {
    await unreleasedFixture();

    // Counted as an attempt to authenticate precisely because nothing here
    // accepts it: serving such a request as anonymous is the silent demotion
    // this rule exists to prevent.
    await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Authorization', 'Bearer sahte-token')
      .expect(401);
  });

  it('leaves the public catalogue reachable with a dead session cookie', async () => {
    // The elevation is what a broken credential blocks. A visitor whose session
    // expired in another tab still gets the catalogue.
    const fixture = await unreleasedFixture();

    const response = await request(ctx.server)
      .get('/categories')
      .set('Cookie', `${COOKIE_NAME}=bu-oturum-hicbir-zaman-var-olmadi`)
      .expect(200);

    expect(response.body.map((category: { slug: string }) => category.slug)).toEqual([
      fixture.live.slug,
    ]);
  });
});
