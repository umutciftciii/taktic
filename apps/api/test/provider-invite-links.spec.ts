import {
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  UserRole,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_INVITE_TTL_DAYS,
  PROVIDER_INVITE_TTL_MS,
} from '../src/modules/provider-invites/provider-invites.constants';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Inviting one business to apply for a service the marketplace has not released.
 *
 * The feature exists to close a gap the draft-binding change left open. An
 * operator can attach a provider to a DRAFT category by hand
 * (provider-draft-category-binding.spec.ts), but only to a provider who is
 * already in the system — and a DRAFT category is invisible to every business
 * that is not, because the public catalogue, the application form's category
 * list and provider discovery all hide it. So the marketplace could prepare
 * supply out of businesses it already had and out of nobody else. An invitation
 * is the missing half: a single-use link an operator hands to one business,
 * which lets that business fill in its own application against a service it
 * still cannot see anywhere else.
 *
 * What the link must not become is the thing this file mostly checks. It is a
 * credential, so it is stored as a digest and returned exactly once; it names
 * one category, so the client is never asked which; it is single use, so two
 * simultaneous submissions cannot both succeed; and it discloses one fact — a
 * name — so a holder learns nothing about the unreleased catalogue beyond the
 * service they were approached about. Every dead link, whatever killed it,
 * answers identically.
 *
 * Ownership of neighbouring rules stays where it already is:
 * category-visibility.spec.ts owns the `includeInactive` access matrix, and
 * provider-draft-category-binding.spec.ts owns what a draft *binding* may do.
 * This file owns the link.
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
  ctx.notifications.clear();
});

async function cookieFor(role: UserRole) {
  const user = await createUser(ctx.prisma, { role });
  return loginAs(ctx.prisma, user.id);
}

/** A draft service, which is the state this feature exists for. */
function draftService(name = 'Taslak Hizmet') {
  return createCategory(ctx.prisma, name, {
    status: ServiceCategoryStatus.DRAFT,
    offerCreditCost: 3,
  });
}

/** Issues a link through the endpoint an operator uses, and hands back the URL. */
async function issueInvite(
  adminCookie: string,
  categoryId: string,
): Promise<{ id: string; url: string; token: string; expiresAt: string }> {
  const response = await request(ctx.server)
    .post(`/categories/${categoryId}/provider-invites`)
    .set('Cookie', adminCookie)
    .send({})
    .expect(201);

  return { ...response.body, token: tokenOf(response.body.url) };
}

/** The raw token, as the recipient's browser would read it off the link. */
function tokenOf(url: string): string {
  const token = new URL(url).pathname.split('/').at(-1);

  if (!token) {
    throw new Error('The issued invitation URL carries no token segment.');
  }

  return decodeURIComponent(token);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The body a guest application posts, minus the category the invite decides. */
function applicationPayload(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    businessName: 'Davetli İşletme',
    contactName: 'Davetli Yetkili',
    phone: '05559990001',
    email: 'davetli@example.test',
    city: 'İstanbul',
    district: 'Kadıköy',
    serviceAreas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    ...overrides,
  };
}

/** The approved-provider figure exactly as the readiness panel reads it. */
async function readinessCounts(
  adminCookie: string,
  slug: string,
): Promise<{ providers: number; invites: number }> {
  const response = await request(ctx.server)
    .get('/categories?includeInactive=true')
    .set('Cookie', adminCookie)
    .expect(200);

  const category = (
    response.body as Array<{
      slug: string;
      _count?: { providers?: number; providerInvites?: number };
    }>
  ).find((entry) => entry.slug === slug);

  return {
    providers: category?._count?.providers ?? 0,
    invites: category?._count?.providerInvites ?? 0,
  };
}

describe('POST /categories/:id/provider-invites', () => {
  it('returns the link once, stores only its digest, and expires it in 14 days', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    const issuedAt = Date.now();
    const invite = await issueInvite(adminCookie, draft.id);

    // The URL is the one the recipient will follow, and it is absolute: an
    // operator pastes it into a message, so a relative path would be useless.
    expect(invite.url).toContain('/provider-invite/');
    // 256 bits of randomness, base64url encoded, is 43 characters.
    expect(invite.token.length).toBeGreaterThanOrEqual(43);

    const stored = await ctx.prisma.providerInviteToken.findUniqueOrThrow({
      where: { id: invite.id },
    });

    // The whole security argument in two assertions: what is written down is a
    // digest, and it is the digest *of this token* — so a database dump cannot
    // be replayed into an application, and the lookup still works.
    expect(stored.tokenHash).toBe(sha256(invite.token));
    expect(stored.tokenHash).not.toBe(invite.token);

    const ttl = stored.expiresAt.getTime() - issuedAt;
    expect(ttl).toBeGreaterThan(PROVIDER_INVITE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(PROVIDER_INVITE_TTL_MS + 60_000);
    expect(PROVIDER_INVITE_TTL_DAYS).toBe(14);
  });

  it('records who issued it and starts the category counter at one', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const draft = await draftService();

    expect((await readinessCounts(adminCookie, draft.slug)).invites).toBe(0);

    const invite = await issueInvite(adminCookie, draft.id);

    expect(invite).toMatchObject({ state: 'ACTIVE' });
    const stored = await ctx.prisma.providerInviteToken.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(stored.createdById).toBe(admin.id);

    expect((await readinessCounts(adminCookie, draft.slug)).invites).toBe(1);
  });

  it('lets one category carry several live links at once', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    // Unlike the claim flow, issuing does not close the previous link: an
    // operator approaching three businesses about the same draft needs three.
    const first = await issueInvite(adminCookie, draft.id);
    const second = await issueInvite(adminCookie, draft.id);
    const third = await issueInvite(adminCookie, draft.id);

    expect(new Set([first.token, second.token, third.token]).size).toBe(3);

    const listed = await request(ctx.server)
      .get(`/categories/${draft.id}/provider-invites`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(listed.body.activeCount).toBe(3);
    expect(listed.body.invites.map((entry: { state: string }) => entry.state)).toEqual([
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
    ]);

    // All three still work; spending one does not touch the others.
    for (const token of [first.token, second.token, third.token]) {
      await request(ctx.server).get(`/provider-invites/${token}`).expect(200);
    }
  });

  it('accepts a live leaf too, so a released service can be staffed the same way', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 2 });

    const invite = await issueInvite(adminCookie, live.id);

    const described = await request(ctx.server)
      .get(`/provider-invites/${invite.token}`)
      .expect(200);
    expect(described.body.categoryName).toBe(live.name);
  });

  it.each([
    ['a group', { kind: ServiceCategoryKind.GROUP, status: ServiceCategoryStatus.DRAFT }],
    ['a router', { kind: ServiceCategoryKind.ROUTER, status: ServiceCategoryStatus.DRAFT }],
    ['a closed service', { kind: ServiceCategoryKind.LEAF, status: ServiceCategoryStatus.INACTIVE }],
  ])('refuses %s', async (_label, options) => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const category = await createCategory(ctx.prisma, 'Davet Edilemez', options);

    const response = await request(ctx.server)
      .post(`/categories/${category.id}/provider-invites`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(409);

    expect(response.body.code).toBe('PROVIDER_INVITE_CATEGORY_NOT_INVITABLE');
    expect(await ctx.prisma.providerInviteToken.count()).toBe(0);
  });

  it('404s on a category that does not exist', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);

    await request(ctx.server)
      .post('/categories/kategori-yok/provider-invites')
      .set('Cookie', adminCookie)
      .send({})
      .expect(404);
  });
});

describe('who may administer invitations', () => {
  /*
   * The privilege is the whole feature. An invitation names an unreleased
   * service and grants the right to apply for it, so every route is checked at
   * the HTTP boundary for every caller who is not an operator — including a
   * PROVIDER, who is the account with the most plausible claim to one.
   */
  it('refuses an anonymous caller, a CUSTOMER and a PROVIDER on all three routes', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService('Gizli Taslak');
    const invite = await issueInvite(adminCookie, draft.id);

    const callers: Array<[string | null, number]> = [
      [null, 401],
      [await cookieFor(UserRole.CUSTOMER), 403],
      [await cookieFor(UserRole.PROVIDER), 403],
    ];

    // Built one at a time rather than as an array: supertest binds an ephemeral
    // listener per request and releases it when that request settles, so three
    // constructed up front and awaited in turn is three requests aimed at two
    // closed ports.
    const routes = [
      () => request(ctx.server).get(`/categories/${draft.id}/provider-invites`),
      () => request(ctx.server).post(`/categories/${draft.id}/provider-invites`).send({}),
      () =>
        request(ctx.server)
          .post(`/categories/${draft.id}/provider-invites/${invite.id}/revoke`)
          .send({}),
    ];

    for (const [cookie, expected] of callers) {
      for (const open of routes) {
        const route = open();
        if (cookie) route.set('Cookie', cookie);
        const response = await route.expect(expected);

        // A refusal must not be a slower way of asking the same question.
        const serialized = JSON.stringify(response.body ?? null);
        expect(serialized).not.toContain(draft.slug);
        expect(serialized).not.toContain(draft.name);
        expect(serialized).not.toContain(invite.token);
      }
    }

    // Nothing was issued and nothing was withdrawn by any of them.
    const stored = await ctx.prisma.providerInviteToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored.map((row) => row.revokedAt)).toEqual([null]);
  });
});

describe('the admin list never carries the token', () => {
  it('shows every state and no secret', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    const live = await issueInvite(adminCookie, draft.id);
    const revoked = await issueInvite(adminCookie, draft.id);
    const expired = await issueInvite(adminCookie, draft.id);
    const spent = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${revoked.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(200);
    await ctx.prisma.providerInviteToken.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(spent.token))
      .expect(201);

    const response = await request(ctx.server)
      .get(`/categories/${draft.id}/provider-invites`)
      .set('Cookie', adminCookie)
      .expect(200);

    const stateOf = (id: string) =>
      (response.body.invites as Array<{ id: string; state: string }>).find(
        (entry) => entry.id === id,
      )?.state;

    expect(stateOf(live.id)).toBe('ACTIVE');
    expect(stateOf(revoked.id)).toBe('REVOKED');
    expect(stateOf(expired.id)).toBe('EXPIRED');
    expect(stateOf(spent.id)).toBe('USED');
    expect(response.body.activeCount).toBe(1);

    // The point of the whole listing: it is a history an operator can read
    // forever, and not one of its rows can be turned back into a link.
    const serialized = JSON.stringify(response.body);
    for (const invite of [live, revoked, expired, spent]) {
      expect(serialized).not.toContain(invite.token);
      expect(serialized).not.toContain(sha256(invite.token));
    }
    expect(serialized).not.toContain('tokenHash');
  });
});

describe('POST /categories/:id/provider-invites/:inviteId/revoke', () => {
  it('kills the link and is idempotent', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);

    const first = await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${invite.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(200);
    const second = await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${invite.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(200);

    expect(first.body.revoked).toBe(true);
    expect(first.body.invite.state).toBe('REVOKED');
    // The second is a completed request, not a failure — and it must not move
    // the timestamp the first one wrote.
    expect(second.body.revoked).toBe(false);
    expect(second.body.invite.revokedAt).toBe(first.body.invite.revokedAt);

    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(404);
    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(404);
    expect((await readinessCounts(adminCookie, draft.slug)).invites).toBe(0);
  });

  it('refuses to revoke a link that belongs to another category', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const other = await draftService('Başka Taslak');
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .post(`/categories/${other.id}/provider-invites/${invite.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(404);

    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
  });

  it('leaves a spent link alone rather than marking it revoked as well', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(201);

    const response = await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${invite.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(200);

    // "Somebody applied with this" and "we withdrew it" are different facts,
    // and the list has to keep saying which one happened.
    expect(response.body.revoked).toBe(false);
    expect(response.body.invite.state).toBe('USED');
    expect(response.body.invite.revokedAt).toBeNull();
  });
});

describe('GET /provider-invites/:token', () => {
  it('shows the service name and the expiry, and nothing else about it', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Gizli Taslak Hizmet', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 7,
    });
    await ctx.prisma.serviceCategory.update({
      where: { id: draft.id },
      data: { description: 'Bu açıklama yalnızca yöneticiye aittir.' },
    });
    await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: draft.id,
        key: 'gizli-soru',
        label: 'Gizli soru',
        type: 'TEXT',
        isActive: true,
        sortOrder: 0,
      },
    });
    const invite = await issueInvite(adminCookie, draft.id);

    const response = await request(ctx.server)
      .get(`/provider-invites/${invite.token}`)
      .expect(200);

    expect(response.body).toEqual({
      valid: true,
      categoryName: draft.name,
      expiresAt: expect.any(String),
    });

    // The name is the one fact a holder was approached about. The description,
    // the question set, the price, the slug and the id are the unreleased
    // catalogue, and being handed a link is not being shown the roadmap.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(draft.slug);
    expect(serialized).not.toContain(draft.id);
    expect(serialized).not.toContain('gizli-soru');
    expect(serialized).not.toContain('yalnızca yöneticiye');
    expect(serialized).not.toContain('offerCreditCost');
  });

  it.each([
    'unknown',
    'used',
    'revoked',
    'expired',
    'closed category',
  ])('answers identically for a %s link', async (kind) => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);
    let token = invite.token;

    if (kind === 'unknown') {
      token = 'ThisTokenWasNeverIssuedByAnybodyAtAll0000000';
    }
    if (kind === 'used') {
      await request(ctx.server)
        .post('/provider-invites/applications')
        .send(applicationPayload(token))
        .expect(201);
    }
    if (kind === 'revoked') {
      await ctx.prisma.providerInviteToken.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      });
    }
    if (kind === 'expired') {
      await ctx.prisma.providerInviteToken.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    }
    if (kind === 'closed category') {
      await ctx.prisma.serviceCategory.update({
        where: { id: draft.id },
        data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
      });
    }

    const response = await request(ctx.server).get(`/provider-invites/${token}`).expect(404);

    // One status, one code, one sentence. Anything that varied between these
    // five would tell a caller feeding it guesses which ones ever existed.
    expect(response.body).toMatchObject({
      statusCode: 404,
      code: 'PROVIDER_INVITE_NOT_FOUND',
      message: 'Davet bağlantısı bulunamadı.',
    });
    expect(JSON.stringify(response.body)).not.toContain(draft.name);
  });

  it('keeps working when the draft is released while the link is live', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(200);

    // Releasing is what the invitation was preparing for. Killing the link at
    // the moment it finally became ordinary would be exactly backwards.
    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(201);
  });
});

describe('POST /provider-invites/applications', () => {
  it('binds the application to the invitation’s category, not to anything sent', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    const response = await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(201);

    // Nothing about the application comes back. The applicant just typed it,
    // and every field returned here would be a field a later change could
    // widen into the draft catalogue.
    expect(response.body).toEqual({ success: true });

    const provider = await ctx.prisma.providerProfile.findFirstOrThrow({
      where: { businessName: 'Davetli İşletme' },
      include: { serviceCategories: true, serviceAreas: true },
    });

    expect(provider.serviceCategories.map((binding) => binding.categoryId)).toEqual([draft.id]);
    expect(provider.userId).toBeNull();
    expect(provider.status).toBe(ProviderStatus.PENDING_REVIEW);
    expect(provider.serviceAreas).toHaveLength(1);
  });

  it('refuses a body that tries to name its own category', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const otherDraft = await draftService('Başka Taslak');
    const invite = await issueInvite(adminCookie, draft.id);

    // There is no field to send, and the global ValidationPipe refuses a body
    // that invents one — so "the client decides which unreleased service it is
    // applying for" is unrepresentable rather than merely unimplemented.
    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token, { categoryIds: [otherDraft.id] }))
      .expect(400);

    expect(await ctx.prisma.providerProfile.count()).toBe(0);
    // Refused before anything was spent: the link still works.
    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
  });

  it('reuses the guest form’s own validation', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    const cases: Array<Record<string, unknown>> = [
      // A province that does not exist. Discovery matches areas as plain text,
      // so an address nowhere is an application nothing can ever reach.
      { city: 'Atlantis' },
      // A service area is mandatory, for the same reason.
      { serviceAreas: [] },
      { businessName: '' },
      { phone: '' },
    ];

    for (const overrides of cases) {
      const invite = await issueInvite(adminCookie, draft.id);
      await request(ctx.server)
        .post('/provider-invites/applications')
        .send(applicationPayload(invite.token, overrides))
        .expect(400);

      // A refused application must not spend the link the business was given.
      await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
    }

    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('refuses a signed-in customer, and does not spend the link', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .post('/provider-invites/applications')
      .set('Cookie', await cookieFor(UserRole.CUSTOMER))
      .send(applicationPayload(invite.token))
      .expect(403);

    expect(await ctx.prisma.providerProfile.count()).toBe(0);
    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
  });

  it('binds the application to a signed-in provider who has no profile yet', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });

    await request(ctx.server)
      .post('/provider-invites/applications')
      .set('Cookie', await loginAs(ctx.prisma, providerUser.id))
      .send(applicationPayload(invite.token))
      .expect(201);

    const provider = await ctx.prisma.providerProfile.findFirstOrThrow({
      where: { businessName: 'Davetli İşletme' },
      include: { serviceCategories: true },
    });

    // The ordinary rule: an application submitted by a signed-in provider is
    // born owned, so no claim link is ever issued for it.
    expect(provider.userId).toBe(providerUser.id);
    expect(provider.serviceCategories.map((binding) => binding.categoryId)).toEqual([draft.id]);
  });

  it('refuses a provider account that already owns an application', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);
    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, { userId: providerUser.id });

    await request(ctx.server)
      .post('/provider-invites/applications')
      .set('Cookie', await loginAs(ctx.prisma, providerUser.id))
      .send(applicationPayload(invite.token))
      .expect(409);

    await request(ctx.server).get(`/provider-invites/${invite.token}`).expect(200);
  });

  it('spends the link exactly once', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(201);

    const second = await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token, { businessName: 'İkinci İşletme' }))
      .expect(404);

    expect(second.body.code).toBe('PROVIDER_INVITE_NOT_FOUND');
    expect(await ctx.prisma.providerProfile.count()).toBe(1);

    const stored = await ctx.prisma.providerInviteToken.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(stored.usedAt).not.toBeNull();
  });

  it('lets exactly one of two simultaneous submissions through', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    const [first, second] = await Promise.all([
      request(ctx.server)
        .post('/provider-invites/applications')
        .send(applicationPayload(invite.token, { businessName: 'Yarışan Bir' })),
      request(ctx.server)
        .post('/provider-invites/applications')
        .send(applicationPayload(invite.token, { businessName: 'Yarışan İki' })),
    ]);

    // Exactly one application, whichever of the two won, and the loser is
    // refused rather than 500ing. *Which* refusal it gets depends on how far
    // apart the two actually landed — and that is what the next case pins,
    // deliberately rather than by hoping.
    const statuses = [first.status, second.status];
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect([404, 409]).toContain(first.status === 201 ? second.status : first.status);
    expect(await ctx.prisma.providerProfile.count()).toBe(1);
  });

  it('tells the loser of a real race that the link was just spent', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    /*
     * The race, reproduced deliberately rather than hoped for.
     *
     * Two submissions fired at once do collide, but how far apart they land is
     * a matter of microseconds, and a suite that asserted on the collision
     * would be asserting on the speed of the machine. So the collision is
     * staged instead: a transaction here writes `usedAt` and holds the row lock
     * without committing, which is exactly the state a winning submission is in
     * for the instant between its UPDATE and its COMMIT.
     *
     * The request below then walks the real path. Its resolve reads the last
     * committed state and finds the link live — it *is* live, the winner has
     * not committed — so it proceeds to its own conditional UPDATE and blocks
     * on the lock. Releasing the holder lets that UPDATE re-evaluate against
     * the now-committed row, match nothing, and produce the refusal a genuine
     * loser gets.
     */
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const winner = ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "ProviderInviteToken" SET "usedAt" = NOW() WHERE "id" = ${invite.id}`;
      await held;
    });

    // `.then` rather than a bare Test: supertest does not put a request on the
    // wire until something subscribes to it, and one that has not started
    // cannot be the one blocked on the lock.
    const loser = request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token, { businessName: 'Yarışı Kaybeden' }))
      .then((response) => response);

    // Long enough for the submission to reach its UPDATE and block on it; an
    // unblocked one settles in a few milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await winner;

    const response = await loser;

    // Something specific rather than the public 404: they were holding a link
    // that *was* live when they pressed the button, and "this never worked"
    // would send them back to the operator for a replacement they do not need.
    // What matters just as much is that their application was not written.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROVIDER_INVITE_ALREADY_USED');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('stops working once the draft is closed', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();
    const invite = await issueInvite(adminCookie, draft.id);

    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ServiceCategoryStatus.INACTIVE })
      .expect(200);

    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(404);

    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });
});

describe('an invited application behaves exactly like any other draft binding', () => {
  /** Applies through a link and hands back the provider it produced. */
  async function applyThroughInvite(adminCookie: string, categoryId: string) {
    const invite = await issueInvite(adminCookie, categoryId);
    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(invite.token))
      .expect(201);

    return ctx.prisma.providerProfile.findFirstOrThrow({
      where: { businessName: 'Davetli İşletme' },
      select: { id: true },
    });
  }

  it('does not count towards release until the applicant is approved', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    const provider = await applyThroughInvite(adminCookie, draft.id);

    // A new application is PENDING_REVIEW, and a pending business cannot be
    // shown a request — so the number a release is signed off against must not
    // move just because somebody filled a form in.
    expect(await readinessCounts(adminCookie, draft.slug)).toMatchObject({
      providers: 0,
      invites: 0,
    });

    await request(ctx.server)
      .patch(`/providers/${provider.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ProviderStatus.APPROVED })
      .expect(200);

    // Approving is what makes it count, with no re-binding: the figure is
    // computed from the provider's status at read time.
    expect((await readinessCounts(adminCookie, draft.slug)).providers).toBe(1);
  });

  it('never reaches the customer catalogue or the applicant’s own panel', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await createCategory(ctx.prisma, 'Gizli Davet Hizmeti', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    const provider = await applyThroughInvite(adminCookie, draft.id);

    // The applicant is approved and then given an account, which is the state
    // with the strongest claim to see what they applied for.
    await request(ctx.server)
      .patch(`/providers/${provider.id}/status`)
      .set('Cookie', adminCookie)
      .send({ status: ProviderStatus.APPROVED })
      .expect(200);
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await ctx.prisma.providerProfile.update({
      where: { id: provider.id },
      data: { userId: ownerUser.id },
    });
    const ownerCookie = await loginAs(ctx.prisma, ownerUser.id);

    const responses = await Promise.all([
      request(ctx.server).get('/categories').expect(200),
      request(ctx.server).get('/providers/me').set('Cookie', ownerCookie).expect(200),
      request(ctx.server)
        .get('/providers/me/dashboard')
        .set('Cookie', ownerCookie)
        .expect(200),
      request(ctx.server).get(`/providers/${provider.id}`).expect(200),
    ]);

    for (const response of responses) {
      const serialized = JSON.stringify(response.body ?? null);
      expect(serialized).not.toContain(draft.slug);
      expect(serialized).not.toContain(draft.name);
      expect(serialized).not.toContain(draft.id);
    }

    // And the operator's own view still names it, so the assertions above are
    // about narrowing rather than about the binding never having existed.
    const adminView = await request(ctx.server)
      .get(`/providers/${provider.id}/service-categories`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(adminView.body.serviceCategories[0]).toMatchObject({
      categoryId: draft.id,
      countsForRelease: true,
    });
  });
});

describe('the invitation count is the operator’s alone', () => {
  it('is absent from the public catalogue and present in the operator’s view', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const live = await createCategory(ctx.prisma, 'Yayındaki Hizmet', { offerCreditCost: 2 });
    await issueInvite(adminCookie, live.id);

    const publicList = await request(ctx.server).get('/categories').expect(200);
    const listed = (publicList.body as Array<{ slug: string; _count: Record<string, unknown> }>)
      .find((entry) => entry.slug === live.slug);

    // "How many businesses have been approached about this" is an operational
    // figure with no reader on the public catalogue. The public response does
    // not compute it, so there is no field for a later change to forget to
    // strip.
    expect(listed).toBeDefined();
    expect(listed?._count).not.toHaveProperty('providerInvites');
    expect(listed?._count).not.toHaveProperty('providers');

    expect((await readinessCounts(adminCookie, live.slug)).invites).toBe(1);
  });

  it('counts only live links', async () => {
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);
    const draft = await draftService();

    const spent = await issueInvite(adminCookie, draft.id);
    const revoked = await issueInvite(adminCookie, draft.id);
    const expired = await issueInvite(adminCookie, draft.id);
    await issueInvite(adminCookie, draft.id);

    expect((await readinessCounts(adminCookie, draft.slug)).invites).toBe(4);

    await request(ctx.server)
      .post('/provider-invites/applications')
      .send(applicationPayload(spent.token))
      .expect(201);
    await request(ctx.server)
      .post(`/categories/${draft.id}/provider-invites/${revoked.id}/revoke`)
      .set('Cookie', adminCookie)
      .expect(200);
    await ctx.prisma.providerInviteToken.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await readinessCounts(adminCookie, draft.slug)).invites).toBe(1);
  });
});
