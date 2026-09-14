import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

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

describe('marketplace auto-publish switch', () => {
  it('reads false with no row, records one audit entry per real change', async () => {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    const before = await request(ctx.server)
      .get('/operations-settings/marketplace-publish')
      .set('Cookie', cookie)
      .expect(200);
    expect(before.body.enabled).toBe(false);

    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Cookie', cookie)
      .send({ enabled: true })
      .expect(200);
    // Same value again: no second audit row.
    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Cookie', cookie)
      .send({ enabled: true })
      .expect(200);

    const row = await ctx.prisma.operationsSettings.findUnique({ where: { id: 'singleton' } });
    expect(row?.marketplaceAutoPublishEnabled).toBe(true);
    const changes = await ctx.prisma.operationsSettingsChange.findMany({
      where: { setting: 'marketplaceAutoPublishEnabled' },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ previousValue: null, newValue: 'true', changedById: admin.id });
  });

  it('is refused to a provider account', async () => {
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const cookie = await loginAs(ctx.prisma, provider.id);
    await request(ctx.server)
      .put('/operations-settings/marketplace-publish')
      .set('Cookie', cookie)
      .send({ enabled: true })
      .expect(403);
  });
});
