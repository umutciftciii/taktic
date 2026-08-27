import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * The password policy, as the server states it.
 *
 * The password-set screens now list their criteria live as the customer types.
 * Those criteria are a reading of this policy and nothing more, so this spec
 * pins the policy itself: at least eight characters, at most a hundred and
 * twenty-eight, and no other rule. If a character-class requirement is ever
 * added here, the screens have to be told — and a test that only checked the
 * screens would have gone on ticking a criterion the API had stopped enforcing.
 *
 * The visual feedback never stands in for this: every case below posts straight
 * to the endpoint, with no browser involved.
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

async function issueActivationToken(): Promise<{ token: string; customerId: string }> {
  const category = await createCategory(ctx.prisma);
  const created = await request(ctx.server)
    .post('/service-requests')
    .send(serviceRequestPayload(category.slug))
    .expect(201);

  const message = ctx.notifications.lastOfTemplate('customer-activation');
  const url = message?.actionUrl;
  if (!url) throw new Error('No activation link was issued for the guest request.');

  return {
    token: new URL(url).searchParams.get('token') ?? '',
    customerId: created.body.customerId as string,
  };
}

describe('customer activation password policy', () => {
  it('refuses a password shorter than eight characters and sets nothing', async () => {
    const { token, customerId } = await issueActivationToken();

    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'Kisa123' })
      .expect(400);

    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.passwordHash).toBeNull();
  });

  it('accepts a password of exactly eight characters', async () => {
    const { token, customerId } = await issueActivationToken();

    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'Sekiz123' })
      .expect(201);

    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.passwordHash).not.toBeNull();
  });

  it('imposes no character-class rule beyond the length', async () => {
    const { token, customerId } = await issueActivationToken();

    // All lower case, no digit, no symbol: eight characters is the whole rule,
    // which is exactly why the screens list only that one criterion.
    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'abcdefgh' })
      .expect(201);

    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.passwordHash).not.toBeNull();
  });

  it('refuses a password longer than the maximum', async () => {
    const { token, customerId } = await issueActivationToken();

    await request(ctx.server)
      .post('/auth/customer-activation')
      .send({ token, password: 'a'.repeat(129) })
      .expect(400);

    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.passwordHash).toBeNull();
  });
});

describe('registration password policy', () => {
  it('refuses a short password and creates no account', async () => {
    const response = await request(ctx.server).post('/auth/register-customer').send({
      name: 'Kısa Şifre',
      email: 'kisa-sifre@example.test',
      password: 'kisa',
    });

    expect(response.status).toBe(400);
    expect(await ctx.prisma.user.count({ where: { email: 'kisa-sifre@example.test' } })).toBe(0);
  });
});
