import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * The instant-publish switch as a public fact — the one boolean the request
 * form needs to say what happens next, and nothing else.
 *
 * The same rule the request path itself follows: no row means off, and the
 * response never carries the operator, the change history or any other
 * operations setting. The admin projection at
 * `/operations-settings/marketplace-publish` stays SUPER_ADMIN only.
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

async function setSwitch(enabled: boolean) {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  const cookie = await loginAs(ctx.prisma, admin.id);
  await request(ctx.server)
    .put('/operations-settings/marketplace-publish')
    .set('Cookie', cookie)
    .send({ enabled })
    .expect(200);
}

describe('GET /marketplace-publish-policy', () => {
  it('answers false when no settings row exists yet', async () => {
    const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(response.body).toEqual({ autoPublishEnabled: false });
  });

  it('answers false after an operator switched instant publish off', async () => {
    await setSwitch(true);
    await setSwitch(false);
    const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(response.body).toEqual({ autoPublishEnabled: false });
  });

  it('answers true while instant publish is on, without a session', async () => {
    await setSwitch(true);
    const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(response.body).toEqual({ autoPublishEnabled: true });
  });

  it('carries the one boolean and nothing about who set it or any other setting', async () => {
    await setSwitch(true);
    const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(Object.keys(response.body)).toEqual(['autoPublishEnabled']);
    expect(response.body.recentChanges).toBeUndefined();
    expect(response.body.updatedBy).toBeUndefined();
    expect(response.body.unviewedOfferRefundWindowHours).toBeUndefined();
  });

  it('answers false, not an error, when the setting cannot be read', async () => {
    await setSwitch(true);
    const read = vi
      .spyOn(ctx.prisma.operationsSettings, 'findUnique')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
      expect(response.body).toEqual({ autoPublishEnabled: false });
    } finally {
      read.mockRestore();
    }
    // The next read is the real one again.
    const after = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(after.body).toEqual({ autoPublishEnabled: true });
  });

  it('is read-only: the public path accepts no write', async () => {
    await request(ctx.server).put('/marketplace-publish-policy').send({ autoPublishEnabled: true }).expect(404);
    await request(ctx.server).post('/marketplace-publish-policy').send({ autoPublishEnabled: true }).expect(404);
    const response = await request(ctx.server).get('/marketplace-publish-policy').expect(200);
    expect(response.body).toEqual({ autoPublishEnabled: false });
  });
});
