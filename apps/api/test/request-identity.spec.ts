import { CustomerOrigin, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetAuthThrottle, resetDatabase, type TestContext } from './harness';

/**
 * One endpoint answers "who is this telephone number + e-mail pair" with one of
 * five product states and nothing else. The matrix below is the whole
 * contract; every case that resolveCustomerForCreate would refuse or attach
 * is named here before a form is filled in.
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
  // This suite shares one app (and so one throttle bucket) across every case;
  // without this, the earlier cases would spend the credential-endpoint budget
  // before the dedicated throttling test gets to it. See resetAuthThrottle.
  resetAuthThrottle(ctx.app);
});

function check(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return request(ctx.server).post('/auth/request-identity-check').set(headers).send(body);
}

const FRESH = { phone: '05551110001', email: 'fresh@example.test' };

async function activeCustomer(phone: string, email: string) {
  return createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone, email });
}

async function claimableCustomer(phone: string, email: string) {
  return createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    phone,
    email,
    password: null,
    customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
  });
}

describe('POST /auth/request-identity-check', () => {
  it('answers new-customer when neither the number nor the address is known', async () => {
    const response = await check(FRESH);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'new-customer' });
  });

  it('requires both fields', async () => {
    expect((await check({ phone: FRESH.phone })).status).toBe(400);
    expect((await check({ email: FRESH.email })).status).toBe(400);
    expect((await check({ ...FRESH, extra: 1 })).status).toBe(400);
  });

  it('answers login-required for an active customer matched by phone, by e-mail, or by both', async () => {
    await activeCustomer('05551110002', 'active@example.test');

    expect((await check({ phone: '05551110002', email: 'other@example.test' })).body).toEqual({ status: 'login-required' });
    expect((await check({ phone: '05551110003', email: 'active@example.test' })).body).toEqual({ status: 'login-required' });
    expect((await check({ phone: '05551110002', email: 'ACTIVE@example.test ' })).body).toEqual({ status: 'login-required' });
  });

  it('matches a stored phone regardless of which un-canonicalised spelling wrote it', async () => {
    // resolveCustomerForCreate and self-registration never canonicalise —
    // whatever the visitor typed is what lands in the row.
    await activeCustomer('5551110012', 'bare@example.test');
    await activeCustomer('905551110013', 'countrycode@example.test');

    expect((await check({ phone: '05551110012', email: FRESH.email })).body).toEqual({ status: 'login-required' });
    expect((await check({ phone: '+905551110013', email: FRESH.email })).body).toEqual({ status: 'login-required' });
  });

  it('answers activation-required for a claimable, password-less account', async () => {
    await claimableCustomer('05551110004', 'claim@example.test');

    expect((await check({ phone: '05551110004', email: 'else@example.test' })).body).toEqual({ status: 'activation-required' });
    expect((await check({ phone: '05551110005', email: 'claim@example.test' })).body).toEqual({ status: 'activation-required' });
  });

  it('answers identity-conflict when the two fields point at two different customer accounts', async () => {
    await activeCustomer('05551110006', 'a@example.test');
    await claimableCustomer('05551110007', 'b@example.test');

    expect((await check({ phone: '05551110006', email: 'b@example.test' })).body).toEqual({ status: 'identity-conflict' });
    expect((await check({ phone: '05551110007', email: 'a@example.test' })).body).toEqual({ status: 'identity-conflict' });
  });

  it('answers unavailable for a provider, an admin, or an inactive account — without saying which', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05551110008', email: 'prov@example.test' });
    await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: '05551110009', email: 'adm@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05551110010', email: 'off@example.test', isActive: false });

    for (const body of [
      { phone: '05551110008', email: FRESH.email },
      { phone: FRESH.phone, email: 'adm@example.test' },
      { phone: '05551110010', email: 'off@example.test' },
      // A provider on one side and a customer on the other is still unavailable.
      { phone: '05551110008', email: 'off@example.test' },
    ]) {
      const response = await check(body);
      expect(response.body).toEqual({ status: 'unavailable' });
    }
  });

  it('never returns anything but the status', async () => {
    await activeCustomer('05551110011', 'leak@example.test');
    const response = await check({ phone: '05551110011', email: 'leak@example.test' });
    expect(Object.keys(response.body)).toEqual(['status']);
  });

  it('is rate limited per client, and a forged X-Forwarded-For does not open a new bucket', async () => {
    // The test app runs without TRUST_PROXY, exactly like a default deployment:
    // Express ignores the header, so every request below shares one tracker.
    let last = 0;
    for (let index = 0; index < 12; index += 1) {
      const response = await check(FRESH, { 'x-forwarded-for': `10.0.0.${index}` });
      last = response.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('POST /auth/request-identity-check/activate', () => {
  // The suite-level beforeEach only truncates the database; it never touches
  // the recording transport (unlike customer-activation.spec.ts's own
  // beforeEach), so a mail sent by one case would otherwise still be sitting
  // in ctx.notifications.sent when the next case inspects it.
  beforeEach(() => {
    ctx.notifications.clear();
  });

  function activate(body: Record<string, unknown>) {
    return request(ctx.server).post('/auth/request-identity-check/activate').send(body);
  }

  it('mails the activation link to the account’s own e-mail, never to the address in the form', async () => {
    // The attacker knows the victim's number and supplies their own mailbox.
    await claimableCustomer('05552220001', 'victim@example.test');

    const response = await activate({ phone: '05552220001', email: 'attacker@example.test' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'accepted' });

    const mails = ctx.notifications.sent.filter((m) => m.template === 'customer-activation');
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe('victim@example.test');
    expect(ctx.notifications.sent.some((m) => m.to === 'attacker@example.test')).toBe(false);

    const token = await ctx.prisma.customerActivationToken.findFirstOrThrow({ where: { usedAt: null } });
    const victim = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'victim@example.test' } });
    expect(token.customerId).toBe(victim.id);
  });

  it('carries a validated redirectTo on the link and drops an invalid one', async () => {
    await claimableCustomer('05552220002', 'back@example.test');

    async function attempt(redirectTo: string) {
      ctx.notifications.clear();
      await ctx.prisma.customerActivationToken.deleteMany();
      await activate({ phone: '05552220002', email: 'back@example.test', redirectTo });
      return ctx.notifications.lastOfTemplate('customer-activation');
    }

    const good = await attempt('/vitrin/abc?step=form');
    expect(good?.actionUrl).toContain('redirectTo=%2Fvitrin%2Fabc%3Fstep%3Dform');

    const bad = await attempt('https://evil.example/x');
    expect(bad?.actionUrl).not.toContain('redirectTo');

    // Percent-encoded protocol-relative: safe-shaped as written, but decodes
    // to `//evil.example`.
    const doubleEncoded = await attempt('/%2f%2fevil.example');
    expect(doubleEncoded?.actionUrl).not.toContain('redirectTo');

    // Percent-encoded NUL: safe-shaped as written, but decodes to a control
    // character.
    const encodedControl = await attempt('/ok%00');
    expect(encodedControl?.actionUrl).not.toContain('redirectTo');

    // An ordinary path plus query string with more than one parameter is
    // still carried, encoded.
    const multiParam = await attempt('/vitrin/abc?step=form&x=1');
    expect(multiParam?.actionUrl).toContain('redirectTo=%2Fvitrin%2Fabc%3Fstep%3Dform%26x%3D1');
  });

  it('answers 202 and sends nothing for every other state', async () => {
    await activeCustomer('05552220003', 'active2@example.test');
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: '05552220004', email: 'prov2@example.test' });
    // A claimable account with no e-mail cannot be mailed.
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER, phone: '05552220005', email: undefined, password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });
    await ctx.prisma.user.update({ where: { phone: '05552220005' }, data: { email: null } });

    for (const body of [
      { phone: FRESH.phone, email: FRESH.email },                       // new-customer
      { phone: '05552220003', email: 'active2@example.test' },          // login-required
      { phone: '05552220004', email: FRESH.email },                     // unavailable
      { phone: '05552220003', email: 'victim@example.test' },           // conflict (if victim exists) or login
      { phone: '05552220005', email: FRESH.email },                     // claimable, no e-mail
    ]) {
      const response = await activate(body);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
    }
    expect(ctx.notifications.sent.filter((m) => m.template === 'customer-activation')).toHaveLength(0);
  });
});
