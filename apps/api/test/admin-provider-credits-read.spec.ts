import { AdminPermission, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * ADMIN-DESIGN-000 (F4): staff read one provider's credits without the
 * provider-owner guard being widened.
 *
 * `GET /providers/:id/credits` stays owner-or-SUPER_ADMIN. The admin screen
 * reads `GET /admin/providers/:id/credits` on FINANCE_LEDGER_READ and
 * `GET /admin/providers/:id/entitlements` on PACKAGE_PURCHASES_READ. Granting
 * and deducting keep their own permissions, and one does not open the other.
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

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

describe('GET /admin/providers/:providerId/credits', () => {
  it('answers a staff account holding FINANCE_LEDGER_READ with the balance, movements and provider label', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await grantCredits(ctx.prisma, provider.id, 25);
    const session = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);

    const response = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/credits`)
      .set('Cookie', session);

    expect(response.status).toBe(200);
    expect(response.body.balance).toBe(25);
    expect(response.body.transactions).toHaveLength(1);
    // The ledger shows who made a movement; this read shows it the same way.
    expect(response.body.transactions[0]).toHaveProperty('createdBy');
    expect(response.body.provider).toEqual({
      id: provider.id,
      businessName: provider.businessName,
      status: provider.status,
      city: provider.city,
      district: provider.district,
    });
  });

  it('refuses a staff account without FINANCE_LEDGER_READ, however much else it holds', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const session = await sessionWith([
      AdminPermission.FINANCE_READ,
      AdminPermission.PROVIDERS_READ_DETAIL,
      AdminPermission.CREDITS_GRANT,
      AdminPermission.CREDITS_DEDUCT,
    ]);

    const response = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/credits`)
      .set('Cookie', session);

    expect(response.status).toBe(403);
  });

  it('answers 404 for a provider that does not exist', async () => {
    const session = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);

    const response = await request(ctx.server)
      .get('/admin/providers/does-not-exist/credits')
      .set('Cookie', session);

    expect(response.status).toBe(404);
  });

  it('refuses the provider who owns the record: this is the staff route', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const session = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/credits`)
      .set('Cookie', session);

    expect(response.status).toBe(403);
  });
});

describe('the provider-owner routes are not widened', () => {
  it('still refuses a staff account holding FINANCE_LEDGER_READ on the provider route', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const session = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);

    const credits = await request(ctx.server)
      .get(`/providers/${provider.id}/credits`)
      .set('Cookie', session);
    const entitlements = await request(ctx.server)
      .get(`/providers/${provider.id}/entitlements`)
      .set('Cookie', session);

    expect(credits.status).toBe(403);
    expect(entitlements.status).toBe(403);
  });

  it('keeps the owner and SUPER_ADMIN reads as they were', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const superAdmin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    for (const userId of [owner.id, superAdmin.id]) {
      const session = await loginAs(ctx.prisma, userId);
      const response = await request(ctx.server)
        .get(`/providers/${provider.id}/credits`)
        .set('Cookie', session);
      expect(response.status).toBe(200);
    }
  });
});

describe('actors outside the staff permissions (ADMIN-DESIGN-001 Faz 3B)', () => {
  it('keeps a provider owner to its own record: no staff read, no other provider, no write at all', async () => {
    const ownerA = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const providerA = await createProviderProfile(ctx.prisma, { userId: ownerA.id });
    const ownerB = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const providerB = await createProviderProfile(ctx.prisma, { userId: ownerB.id });
    await grantCredits(ctx.prisma, providerA.id, 10);
    await grantCredits(ctx.prisma, providerB.id, 10);
    const session = await loginAs(ctx.prisma, ownerA.id);
    const body = { amount: 3, reason: 'Faz 3B çapraz deneme' };

    const reads = await Promise.all([
      request(ctx.server).get(`/providers/${providerB.id}/credits`).set('Cookie', session),
      request(ctx.server).get(`/providers/${providerB.id}/entitlements`).set('Cookie', session),
      request(ctx.server).get(`/admin/providers/${providerB.id}/credits`).set('Cookie', session),
      request(ctx.server).get(`/admin/providers/${providerB.id}/entitlements`).set('Cookie', session),
    ]);
    for (const response of reads) {
      expect(response.status).toBe(403);
    }

    for (const providerId of [providerA.id, providerB.id]) {
      for (const path of ['grant', 'deduct']) {
        const response = await request(ctx.server)
          .post(`/providers/${providerId}/credits/${path}`)
          .set('Cookie', session)
          .send(body);
        expect(response.status, `${path} on ${providerId}`).toBe(403);
      }
    }

    // Its own record through its own route is untouched by this slice.
    const own = await request(ctx.server).get(`/providers/${providerA.id}/credits`).set('Cookie', session);
    expect(own.status).toBe(200);
    expect(await currentCreditBalance(ctx.prisma, providerA.id)).toBe(10);
    expect(await currentCreditBalance(ctx.prisma, providerB.id)).toBe(10);
  });

  it('refuses a customer every credit read and write, staff route or provider route', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const session = await loginAs(ctx.prisma, customer.id);
    const body = { amount: 1, reason: 'Faz 3B müşteri denemesi' };

    const responses = await Promise.all([
      request(ctx.server).get(`/providers/${provider.id}/credits`).set('Cookie', session),
      request(ctx.server).get(`/admin/providers/${provider.id}/credits`).set('Cookie', session),
      request(ctx.server).get(`/admin/providers/${provider.id}/entitlements`).set('Cookie', session),
      request(ctx.server).post(`/providers/${provider.id}/credits/grant`).set('Cookie', session).send(body),
      request(ctx.server).post(`/providers/${provider.id}/credits/deduct`).set('Cookie', session).send(body),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
    }
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });

  it('refuses an anonymous caller with 401 and writes nothing', async () => {
    const provider = await createProviderProfile(ctx.prisma);

    const read = await request(ctx.server).get(`/admin/providers/${provider.id}/credits`);
    const write = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/grant`)
      .send({ amount: 1, reason: 'anonim' });

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });
});

describe('GET /admin/providers/:providerId/entitlements', () => {
  it('answers a staff account holding PACKAGE_PURCHASES_READ', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const session = await sessionWith([AdminPermission.PACKAGE_PURCHASES_READ]);

    const response = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/entitlements`)
      .set('Cookie', session);

    expect(response.status).toBe(200);
  });

  it('refuses FINANCE_LEDGER_READ alone: periods carry payment references', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const session = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);

    const response = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/entitlements`)
      .set('Cookie', session);

    expect(response.status).toBe(403);
  });
});

describe('manual credit writes keep their own permissions', () => {
  it('lets CREDITS_GRANT grant and not deduct, and CREDITS_DEDUCT deduct and not grant', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await grantCredits(ctx.prisma, provider.id, 10);
    const grantOnly = await sessionWith([AdminPermission.FINANCE_LEDGER_READ, AdminPermission.CREDITS_GRANT]);
    const deductOnly = await sessionWith([AdminPermission.FINANCE_LEDGER_READ, AdminPermission.CREDITS_DEDUCT]);
    const body = { amount: 2, reason: 'ADMIN-DESIGN-000 test' };

    const grantByGrant = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/grant`)
      .set('Cookie', grantOnly)
      .send(body);
    const deductByGrant = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/deduct`)
      .set('Cookie', grantOnly)
      .send(body);
    const deductByDeduct = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/deduct`)
      .set('Cookie', deductOnly)
      .send(body);
    const grantByDeduct = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/grant`)
      .set('Cookie', deductOnly)
      .send(body);

    expect(grantByGrant.status).toBe(201);
    expect(deductByGrant.status).toBe(403);
    expect(deductByDeduct.status).toBe(201);
    expect(grantByDeduct.status).toBe(403);
    // 10 + 2 − 2: the two refusals moved nothing.
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(10);
  });

  it('records each staff write with its actor, type and reason, and an overdraft writes nothing', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await grantCredits(ctx.prisma, provider.id, 5);
    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.FINANCE_LEDGER_READ,
      AdminPermission.CREDITS_GRANT,
      AdminPermission.CREDITS_DEDUCT,
    ]);
    const session = await loginAs(ctx.prisma, admin.id);

    const granted = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/grant`)
      .set('Cookie', session)
      .send({ amount: 7, reason: 'Faz 3B denetim: ekleme' });
    const deducted = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/deduct`)
      .set('Cookie', session)
      .send({ amount: 4, reason: 'Faz 3B denetim: düşme' });
    const overdraft = await request(ctx.server)
      .post(`/providers/${provider.id}/credits/deduct`)
      .set('Cookie', session)
      .send({ amount: 100, reason: 'Faz 3B denetim: fazla düşme' });

    expect(granted.status).toBe(201);
    expect(deducted.status).toBe(201);
    expect(overdraft.status).toBe(400);

    const rows = await ctx.prisma.providerCreditTransaction.findMany({
      where: { providerId: provider.id, type: { in: ['ADMIN_GRANT', 'ADMIN_DEDUCT'] }, createdById: admin.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { type: true, amount: true, balanceAfter: true, reason: true, createdById: true },
    });
    expect(rows).toEqual([
      { type: 'ADMIN_GRANT', amount: 7, balanceAfter: 12, reason: 'Faz 3B denetim: ekleme', createdById: admin.id },
      { type: 'ADMIN_DEDUCT', amount: -4, balanceAfter: 8, reason: 'Faz 3B denetim: düşme', createdById: admin.id },
    ]);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(8);

    // The staff read shows the same rows with the actor, as the ledger does.
    const read = await request(ctx.server)
      .get(`/admin/providers/${provider.id}/credits`)
      .set('Cookie', session);
    expect(read.status).toBe(200);
    expect(read.body.transactions[0].createdBy).toMatchObject({ id: admin.id });
  });

  it('refuses an amount that is not a positive integer and records nothing', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await grantCredits(ctx.prisma, provider.id, 5);
    const session = await sessionWith([
      AdminPermission.FINANCE_LEDGER_READ,
      AdminPermission.CREDITS_GRANT,
      AdminPermission.CREDITS_DEDUCT,
    ]);

    for (const amount of [2.5, 0, -3, '1e2', '100', null]) {
      for (const path of ['grant', 'deduct']) {
        const response = await request(ctx.server)
          .post(`/providers/${provider.id}/credits/${path}`)
          .set('Cookie', session)
          .send({ amount, reason: 'Faz 3B tutar sözleşmesi' });
        expect(response.status, `${path} ${JSON.stringify(amount)}`).toBe(400);
      }
    }
    expect(await ctx.prisma.providerCreditTransaction.count({ where: { providerId: provider.id } })).toBe(1);
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(5);
  });

  it('refuses both writes to a ledger reader holding neither', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    const session = await sessionWith([AdminPermission.FINANCE_LEDGER_READ]);
    const body = { amount: 1, reason: 'ADMIN-DESIGN-000 test' };

    for (const path of ['grant', 'deduct']) {
      const response = await request(ctx.server)
        .post(`/providers/${provider.id}/credits/${path}`)
        .set('Cookie', session)
        .send(body);
      expect(response.status).toBe(403);
    }
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });
});
