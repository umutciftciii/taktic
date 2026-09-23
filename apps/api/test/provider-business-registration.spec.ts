import { AdminPermission, ProviderStatus, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The canonical business registration through the real routes (CMP-006 PR-C
 * design §1): the two application paths, the provider's own route, the
 * masked projections everywhere else, and the one audited raw read.
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

/** Check digits valid; unlikely to appear anywhere else in a response. */
const TCKN = '10000000146';
const TCKN_MASKED = '*********46';

async function apply(overrides: Record<string, unknown>, status: number) {
  const category = await createCategory(ctx.prisma, `Kategori ${Math.random().toString(36).slice(2, 8)}`);
  return request(ctx.server).post('/providers').send({ ...providerPayload([category.id]), ...overrides }).expect(status);
}

async function ownedProvider(options: { legacyTax?: boolean } = {}) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
  if (options.legacyTax === false) {
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { taxType: null, taxNumber: null } });
  }
  return { owner, provider, cookie: await loginAs(ctx.prisma, owner.id) };
}

function putOwn(cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).put('/providers/me/business-registration').set('Cookie', cookie).send(body);
}

describe('the open application', () => {
  it.each([
    ['TAX_NUMBER', '123 456 7890', '1234567890', '********90'],
    ['MERSIS', '0123-4567-8901-2345', '0123456789012345', '**************45'],
    ['TRADE_REGISTRY', '12345', '12345', '***45'],
    ['CRAFTSMAN_REGISTRY', '34/1234', '341234', '****34'],
    ['SOLE_PROPRIETOR_TR_ID', TCKN, TCKN, TCKN_MASKED],
  ])('%s: stored canonical, answered masked, one history row without the number', async (type, input, canonical, masked) => {
    const response = await apply({ businessRegistrationType: type, businessRegistrationNumber: input }, 201);

    expect(response.body.businessRegistration).toMatchObject({ status: 'DECLARED', type, numberMasked: masked });
    expect(JSON.stringify(response.body)).not.toContain(canonical);
    const row = await ctx.prisma.providerBusinessRegistration.findUniqueOrThrow({ where: { providerId: response.body.id } });
    expect(row).toMatchObject({ type, numberCanonical: canonical, numberMasked: masked, fingerprintVersion: 1 });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const history = await ctx.prisma.providerBusinessRegistrationChange.findMany({ where: { providerId: response.body.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actorKind: 'APPLICANT', previousType: null, newType: type, newFingerprint: row.fingerprint });
    expect(JSON.stringify(history)).not.toContain(canonical);
  });

  it('NONE_DECLARED is accepted and stores no number, mask or fingerprint', async () => {
    const response = await apply({ businessRegistrationType: 'NONE_DECLARED' }, 201);
    expect(response.body.businessRegistration).toMatchObject({ status: 'NONE_DECLARED', type: 'NONE_DECLARED', numberMasked: null });
    expect(await ctx.prisma.providerBusinessRegistration.findUniqueOrThrow({ where: { providerId: response.body.id } })).toMatchObject({
      numberCanonical: null,
      numberMasked: null,
      fingerprint: null,
      fingerprintVersion: null,
    });
  });

  it.each([
    [{ businessRegistrationNumber: '1234567890' }, 'BUSINESS_REGISTRATION_TYPE_REQUIRED'],
    [{ businessRegistrationType: 'TAX_NUMBER' }, 'BUSINESS_REGISTRATION_NUMBER_REQUIRED'],
    [{ businessRegistrationType: 'NONE_DECLARED', businessRegistrationNumber: '1234567890' }, 'BUSINESS_REGISTRATION_NUMBER_NOT_ALLOWED'],
    [{ businessRegistrationType: 'TAX_NUMBER', businessRegistrationNumber: '123' }, 'BUSINESS_REGISTRATION_NUMBER_INVALID'],
    [{ businessRegistrationType: 'SOLE_PROPRIETOR_TR_ID', businessRegistrationNumber: '10000000147' }, 'BUSINESS_REGISTRATION_NUMBER_INVALID'],
    [{ businessRegistrationType: 'PASSPORT', businessRegistrationNumber: '1234567890' }, 'BUSINESS_REGISTRATION_TYPE_REQUIRED'],
  ])('%o → 400 %s, no profile written, and the number is not echoed', async (overrides, code) => {
    const response = await apply(overrides, 400);
    expect(response.body.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toContain('10000000147');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
    expect(await ctx.prisma.providerBusinessRegistration.count()).toBe(0);
  });

  it('an application that declares nothing is written without a registration: "unspecified"', async () => {
    const response = await apply({}, 201);
    expect(response.body.businessRegistration).toEqual({ status: 'UNSPECIFIED', type: null, numberMasked: null, updatedAt: null });
    expect(await ctx.prisma.providerBusinessRegistration.count()).toBe(0);
  });
});

describe('the invited application', () => {
  it('carries the same pair through the same checks', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);
    const draft = await createCategory(ctx.prisma, 'Taslak Hizmet', { status: ServiceCategoryStatus.DRAFT, offerCreditCost: 3 });
    const invite = await request(ctx.server).post(`/categories/${draft.id}/provider-invites`).set('Cookie', adminCookie).send({}).expect(201);
    const token = new URL(invite.body.url).pathname.split('/').at(-1)!;
    const payload = {
      token,
      businessName: 'Davetli İşletme',
      contactName: 'Davetli Yetkili',
      phone: '05559990001',
      email: 'davetli@example.test',
      city: 'İstanbul',
      district: 'Kadıköy',
      serviceAreas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    };

    const refused = await request(ctx.server)
      .post('/provider-invites/applications')
      .send({ ...payload, businessRegistrationType: 'MERSIS', businessRegistrationNumber: '12' })
      .expect(400);
    expect(refused.body.code).toBe('BUSINESS_REGISTRATION_NUMBER_INVALID');

    await request(ctx.server)
      .post('/provider-invites/applications')
      .send({ ...payload, businessRegistrationType: 'SOLE_PROPRIETOR_TR_ID', businessRegistrationNumber: TCKN })
      .expect(201);
    const provider = await ctx.prisma.providerProfile.findFirstOrThrow({ include: { businessRegistration: true } });
    expect(provider.businessRegistration).toMatchObject({ type: 'SOLE_PROPRIETOR_TR_ID', numberMasked: TCKN_MASKED });
  });
});

describe('legacy taxType/taxNumber', () => {
  it('are never converted, and a profile save that does not send them leaves them as they were', async () => {
    const { provider, cookie } = await ownedProvider();
    expect(await ctx.prisma.providerBusinessRegistration.count()).toBe(0);
    const category = await createCategory(ctx.prisma, 'Klima');
    await ctx.prisma.providerServiceCategory.create({ data: { providerId: provider.id, categoryId: category.id } });

    const saved = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), businessName: 'Yeni Ad' })
      .expect(200);

    const row = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } });
    expect(row).toMatchObject({ businessName: 'Yeni Ad', taxType: provider.taxType, taxNumber: provider.taxNumber });
    expect(JSON.stringify(saved.body)).not.toContain(provider.taxNumber!);
    expect(await ctx.prisma.providerBusinessRegistration.count()).toBe(0);
  });

  it('the profile form cannot carry the registration: it has its own route', async () => {
    const { provider, cookie } = await ownedProvider();
    const category = await createCategory(ctx.prisma, 'Klima');
    const response = await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), businessRegistrationType: 'TAX_NUMBER', businessRegistrationNumber: '1234567890' })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('businessRegistrationType');
  });
});

describe("the provider's own registration", () => {
  it('reads "unspecified" with the legacy pair masked, then replaces it; the same value twice adds no history', async () => {
    const { provider, cookie } = await ownedProvider();

    const before = await request(ctx.server).get('/providers/me/business-registration').set('Cookie', cookie).expect(200);
    expect(before.body).toEqual({
      registration: { status: 'UNSPECIFIED', type: null, numberMasked: null, updatedAt: null },
      legacy: { taxType: provider.taxType, taxNumberMasked: `********${provider.taxNumber!.slice(-2)}` },
    });

    const put = await putOwn(cookie, { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN }).expect(200);
    expect(put.body.registration).toMatchObject({ status: 'DECLARED', type: 'SOLE_PROPRIETOR_TR_ID', numberMasked: TCKN_MASKED });
    expect(JSON.stringify(put.body)).not.toContain(TCKN);
    await putOwn(cookie, { type: 'SOLE_PROPRIETOR_TR_ID', number: `${TCKN.slice(0, 3)} ${TCKN.slice(3)}` }).expect(200);
    await putOwn(cookie, { type: 'NONE_DECLARED' }).expect(200);

    const history = await ctx.prisma.providerBusinessRegistrationChange.findMany({
      where: { providerId: provider.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((row) => [row.actorKind, row.previousType, row.newType])).toEqual([
      ['PROVIDER', null, 'SOLE_PROPRIETOR_TR_ID'],
      ['PROVIDER', 'SOLE_PROPRIETOR_TR_ID', 'NONE_DECLARED'],
    ]);
    expect(history[1]!.newFingerprint).toBeNull();
  });

  it('refuses an empty declaration, a mismatched number, a customer and an operator', async () => {
    const { cookie } = await ownedProvider();
    expect((await putOwn(cookie, {}).expect(400)).body.code).toBe('BUSINESS_REGISTRATION_TYPE_REQUIRED');
    expect((await putOwn(cookie, { type: 'TAX_NUMBER', number: 'abc' }).expect(400)).body.code).toBe(
      'BUSINESS_REGISTRATION_NUMBER_INVALID',
    );
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    await putOwn(await loginAs(ctx.prisma, customer.id), { type: 'NONE_DECLARED' }).expect(403);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await putOwn(await loginAs(ctx.prisma, admin.id), { type: 'NONE_DECLARED' }).expect(403);
    await request(ctx.server).put('/providers/me/business-registration').send({ type: 'NONE_DECLARED' }).expect(401);
  });
});

describe('leak matrix — no raw number outside the audited route', () => {
  async function declared() {
    const { owner, provider, cookie } = await ownedProvider();
    await putOwn(cookie, { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN }).expect(200);
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { status: ProviderStatus.APPROVED } });
    return { owner, provider, cookie };
  }

  it('public, owner, staff, list, admin detail, dashboard: masked or absent, never raw', async () => {
    const { provider, cookie } = await declared();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.PROVIDERS_READ,
      AdminPermission.PROVIDERS_READ_DETAIL,
    ]);
    const staff = await loginAs(ctx.prisma, admin.id);

    const bodies = {
      public: (await request(ctx.server).get(`/providers/${provider.id}`).expect(200)).body,
      owner: (await request(ctx.server).get(`/providers/${provider.id}`).set('Cookie', cookie).expect(200)).body,
      me: (await request(ctx.server).get('/providers/me').set('Cookie', cookie).expect(200)).body,
      dashboard: (await request(ctx.server).get('/providers/me/dashboard').set('Cookie', cookie).expect(200)).body,
      staff: (await request(ctx.server).get(`/providers/${provider.id}`).set('Cookie', staff).expect(200)).body,
      list: (await request(ctx.server).get('/providers').set('Cookie', staff).expect(200)).body,
      detail: (await request(ctx.server).get(`/providers/${provider.id}/admin-detail`).set('Cookie', staff).expect(200)).body,
    };

    for (const [name, body] of Object.entries(bodies)) {
      const serialized = JSON.stringify(body);
      expect(serialized, name).not.toContain(TCKN);
      expect(serialized, name).not.toContain(provider.taxNumber!);
      expect(serialized, name).not.toContain('numberCanonical');
      expect(serialized, name).not.toContain('fingerprint');
    }
    expect(bodies.public).not.toHaveProperty('businessRegistration');
    expect(bodies.public).not.toHaveProperty('taxNumberMasked');
    for (const body of [bodies.owner, bodies.me, bodies.dashboard.provider, bodies.staff, bodies.detail]) {
      expect(body.businessRegistration).toMatchObject({ type: 'SOLE_PROPRIETOR_TR_ID', numberMasked: TCKN_MASKED });
    }
    // The list carries the registration masked and no legacy tax number at all.
    expect(bodies.list[0].businessRegistration.numberMasked).toBe(TCKN_MASKED);
    expect(bodies.list[0]).not.toHaveProperty('taxNumberMasked');
    expect(bodies.list[0]).not.toHaveProperty('taxNumber');
    expect(bodies.detail.taxNumberMasked).toBe(`********${provider.taxNumber!.slice(-2)}`);
    // No read above was a sensitive read.
    expect(await ctx.prisma.sensitiveDataAccessLog.count()).toBe(0);
  });
});

describe('GET /providers/:id/business-registration/raw', () => {
  it('needs PROVIDER_REGISTRATION_READ_SENSITIVE: the detail and list permissions are not enough', async () => {
    const { provider } = await ownedProvider();
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.PROVIDERS_READ,
      AdminPermission.PROVIDERS_READ_DETAIL,
      AdminPermission.PROVIDERS_WRITE,
    ]);
    const refused = await request(ctx.server)
      .get(`/providers/${provider.id}/business-registration/raw`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(403);
    expect(JSON.stringify(refused.body)).not.toContain(provider.taxNumber!);
    const owner = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id }, select: { userId: true } });
    await request(ctx.server)
      .get(`/providers/${provider.id}/business-registration/raw`)
      .set('Cookie', await loginAs(ctx.prisma, owner.userId!))
      .expect(403);
    await request(ctx.server).get(`/providers/${provider.id}/business-registration/raw`).expect(401);
    expect(await ctx.prisma.sensitiveDataAccessLog.count()).toBe(0);
  });

  it('answers the raw values, uncached, and writes one access row per read — field names, never values', async () => {
    const { provider, cookie } = await ownedProvider();
    await putOwn(cookie, { type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN }).expect(200);
    const { admin } = await createAdminWithPermissions(ctx.prisma, [AdminPermission.PROVIDER_REGISTRATION_READ_SENSITIVE]);
    const staff = await loginAs(ctx.prisma, admin.id);

    const first = await request(ctx.server).get(`/providers/${provider.id}/business-registration/raw`).set('Cookie', staff).expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toMatchObject({
      providerId: provider.id,
      registration: { status: 'DECLARED', type: 'SOLE_PROPRIETOR_TR_ID', number: TCKN, numberMasked: TCKN_MASKED },
      legacy: { taxType: provider.taxType, taxNumber: provider.taxNumber },
    });
    await request(ctx.server).get(`/providers/${provider.id}/business-registration/raw`).set('Cookie', staff).expect(200);

    const log = await ctx.prisma.sensitiveDataAccessLog.findMany({ orderBy: { readAt: 'asc' } });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actorId: admin.id,
      providerId: provider.id,
      subject: 'PROVIDER_BUSINESS_REGISTRATION',
      fields: ['ProviderBusinessRegistration.numberCanonical', 'ProviderProfile.taxNumber'],
    });
    expect(JSON.stringify(log)).not.toContain(TCKN);
    expect(JSON.stringify(log)).not.toContain(provider.taxNumber!);
  });

  it('SUPER_ADMIN reads it without a role; an unknown provider is 404 and logs nothing', async () => {
    const { provider } = await ownedProvider();
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, root.id);
    const response = await request(ctx.server).get(`/providers/${provider.id}/business-registration/raw`).set('Cookie', cookie).expect(200);
    expect(response.body.registration.status).toBe('UNSPECIFIED');
    await request(ctx.server).get('/providers/nope/business-registration/raw').set('Cookie', cookie).expect(404);
    expect(await ctx.prisma.sensitiveDataAccessLog.count()).toBe(1);
  });

  it('the access log and the history are append-only in the database', async () => {
    const { provider, cookie } = await ownedProvider();
    await putOwn(cookie, { type: 'TAX_NUMBER', number: '1234567890' }).expect(200);
    const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .get(`/providers/${provider.id}/business-registration/raw`)
      .set('Cookie', await loginAs(ctx.prisma, root.id))
      .expect(200);

    await expect(ctx.prisma.sensitiveDataAccessLog.deleteMany()).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.providerBusinessRegistrationChange.updateMany({ data: { newFingerprint: null } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('the database refuses a number on NONE_DECLARED and a declared type without one', async () => {
    const { provider } = await ownedProvider();
    await expect(
      ctx.prisma.providerBusinessRegistration.create({
        data: { providerId: provider.id, type: 'NONE_DECLARED', numberCanonical: '1234567890', numberMasked: '********90' },
      }),
    ).rejects.toThrow(/number_matches_type/);
    await expect(
      ctx.prisma.providerBusinessRegistration.create({ data: { providerId: provider.id, type: 'TAX_NUMBER' } }),
    ).rejects.toThrow(/number_matches_type/);
  });
});
