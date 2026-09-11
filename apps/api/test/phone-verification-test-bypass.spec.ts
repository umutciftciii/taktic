import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPhoneVerificationTestBypassConfig,
  isPhoneVerificationTestBypassMatch,
  PHONE_VERIFICATION_TEST_BYPASS_VARS as VARS,
} from '../src/modules/phone-verification/phone-verification-test-bypass.config';
import {
  createApprovedRequest,
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The phone-verification test bypass: a second code the screen accepts for a
 * listed number, on a local or staging stack, until a stated moment.
 *
 * Every case here is a clause of the contract in
 * phone-verification-test-bypass.config.ts, exercised through the real
 * endpoints where one exists. The matrix is the point: each clause is tested
 * failing on its own with every other clause satisfied, so a future change
 * that relaxes one cannot hide behind the others.
 *
 * The test code and the allow-list below are placeholders that mean nothing
 * outside this file. Nothing here reads a developer's own environment: every
 * variable is set and removed by the suite.
 */

const TEST_PHONE = '+905559980042';
const TEST_PHONE_NATIONAL = '05559980042';
const TEST_CODE = '424242';
const OTHER_PHONE = '+905559980043';
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

const MANAGED = ['APP_ENVIRONMENT', 'NODE_ENV', VARS.enabled, VARS.phones, VARS.code, VARS.expiresAt];

let ctx: TestContext;
let original: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.sms.clear();
  original = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** Every clause satisfied. Each case below breaks exactly one. */
function arm(overrides: Partial<Record<string, string | null>> = {}) {
  const values: Record<string, string | null> = {
    APP_ENVIRONMENT: 'local',
    [VARS.enabled]: 'true',
    [VARS.phones]: `${TEST_PHONE}, 0555 111 22 33`,
    [VARS.code]: TEST_CODE,
    [VARS.expiresAt]: FUTURE,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const api = () => request(ctx.server);

async function standaloneFixture(phone = TEST_PHONE) {
  const sent = await api().post('/showcase/lead-verification').send({ phone });
  expect(sent.status).toBe(200);
  return { phone, sentCode: ctx.sms.lastCode() };
}

async function requestFixture() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  await ctx.prisma.serviceRequest.update({
    where: { id: serviceRequest.id },
    data: { customerPhone: TEST_PHONE_NATIONAL },
  });
  const cookie = await loginAs(ctx.prisma, customer.id);
  await api()
    .post(`/service-requests/${serviceRequest.id}/phone-verification`)
    .set('Cookie', cookie)
    .expect(201);
  return { serviceRequest, cookie, sentCode: ctx.sms.lastCode() };
}

describe('the matrix', () => {
  it('local + flag + listed number + right code + future expiry → verified, and audited as a test proof', async () => {
    arm();
    const { phone } = await standaloneFixture();

    const verified = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone, code: TEST_CODE });

    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('verified');
    // The screen's answer is the ordinary one: nothing says a test code was used.
    expect(JSON.stringify(verified.body)).not.toMatch(/bypass|test/i);

    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: TEST_PHONE },
    });
    expect(row.consumedAt).not.toBeNull();
    expect(row.verifiedByTestBypass).toBe(true);
    // The audit distinction, and nothing else: no code on the row.
    expect(JSON.stringify(row)).not.toContain(TEST_CODE);
  });

  it('staging + the same conditions → verified', async () => {
    arm({ APP_ENVIRONMENT: 'staging' });
    const { phone } = await standaloneFixture();

    const verified = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone, code: TEST_CODE });

    expect(verified.status).toBe(200);
  });

  it('production environment + flag true → refused', async () => {
    arm({ APP_ENVIRONMENT: 'production' });
    const { phone } = await standaloneFixture();

    const refused = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone, code: TEST_CODE });

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('PHONE_VERIFICATION_INVALID');
  });

  it('NODE_ENV=production + flag true → refused, whatever APP_ENVIRONMENT says', () => {
    arm({ NODE_ENV: 'production', APP_ENVIRONMENT: 'staging' });
    expect(isPhoneVerificationTestBypassMatch(TEST_PHONE, TEST_CODE)).toBe(false);
  });

  it('no declared environment → refused: unknown is closed', async () => {
    arm({ APP_ENVIRONMENT: null });
    const { phone } = await standaloneFixture();

    const refused = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone, code: TEST_CODE });

    expect(refused.status).toBe(400);
  });

  it('a past expiry → refused', async () => {
    arm({ [VARS.expiresAt]: PAST });
    const { phone } = await standaloneFixture();
    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);
  });

  it('a missing or malformed expiry → refused', async () => {
    arm({ [VARS.expiresAt]: null });
    const { phone } = await standaloneFixture();
    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);

    arm({ [VARS.expiresAt]: 'yarın' });
    expect(isPhoneVerificationTestBypassMatch(TEST_PHONE, TEST_CODE)).toBe(false);
  });

  it('the wrong code → refused, and it costs an attempt', async () => {
    arm();
    const { phone } = await standaloneFixture();

    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: '424243' }))
        .status,
    ).toBe(400);

    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: TEST_PHONE },
    });
    expect(row.attemptCount).toBe(1);
    expect(row.consumedAt).toBeNull();
  });

  it('a number not on the list → refused with the test code, verified with the sent one', async () => {
    arm();
    const { phone, sentCode } = await standaloneFixture(OTHER_PHONE);

    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);

    const ok = await api().post('/showcase/lead-verification/verify').send({ phone, code: sentCode });
    expect(ok.status).toBe(200);
    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: OTHER_PHONE },
    });
    expect(row.verifiedByTestBypass).toBe(false);
  });

  it('flag off → refused, however complete the rest is', async () => {
    arm({ [VARS.enabled]: null });
    const { phone } = await standaloneFixture();
    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);

    // "1", "yes" and "TRUE" are not "true".
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      arm({ [VARS.enabled]: value });
      expect(isPhoneVerificationTestBypassMatch(TEST_PHONE, TEST_CODE)).toBe(false);
    }
  });

  it('cannot be opened by a request: Origin, Host, Referer and forwarded headers change nothing', async () => {
    arm({ APP_ENVIRONMENT: 'production' });
    const { phone } = await standaloneFixture();

    const spoofed = await api()
      .post('/showcase/lead-verification/verify')
      .set('Origin', 'http://localhost:3000')
      .set('Host', 'localhost:3001')
      .set('Referer', 'http://localhost:3000/vitrin')
      .set('X-Forwarded-Host', 'staging.example.test')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('X-App-Environment', 'local')
      .query({ env: 'local', bypass: 'true' })
      .send({ phone, code: TEST_CODE });

    expect(spoofed.status).toBe(400);
  });
});

describe('what stays exactly as it was', () => {
  it('the sent code still verifies a listed number, and is recorded as a real proof', async () => {
    arm();
    const { phone, sentCode } = await standaloneFixture();

    const ok = await api().post('/showcase/lead-verification/verify').send({ phone, code: sentCode });
    expect(ok.status).toBe(200);
    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: TEST_PHONE },
    });
    expect(row.verifiedByTestBypass).toBe(false);
  });

  it('the test code needs a live row: nothing sent, nothing to verify', async () => {
    arm();
    const refused = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone: TEST_PHONE, code: TEST_CODE });
    expect(refused.status).toBe(400);
  });

  it('the test code does not reopen an expired row', async () => {
    arm();
    const { phone } = await standaloneFixture();
    await ctx.prisma.phoneVerification.updateMany({
      where: { normalizedPhone: TEST_PHONE },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);
  });

  it('the attempt budget and the lock apply to the test code like any other', async () => {
    arm();
    const { phone } = await standaloneFixture();

    for (let i = 0; i < 5; i += 1) {
      await api().post('/showcase/lead-verification/verify').send({ phone, code: '000000' });
    }
    const locked = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: TEST_PHONE },
    });
    expect(locked.lockedUntil).not.toBeNull();

    // Locked is locked: the test code does not get past it either.
    expect(
      (await api().post('/showcase/lead-verification/verify').send({ phone, code: TEST_CODE }))
        .status,
    ).toBe(400);
  });

  it('the send budget is unchanged: a listed number gets no extra sends', async () => {
    arm();
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await api().post('/showcase/lead-verification').send({ phone: TEST_PHONE })).status,
      ).toBe(200);
    }
    expect(
      (await api().post('/showcase/lead-verification').send({ phone: TEST_PHONE })).status,
    ).toBe(429);
  });

  it('the request-bound path accepts it too, stamps phoneVerifiedAt, and audits the row', async () => {
    arm();
    const { serviceRequest, cookie } = await requestFixture();

    const verified = await api()
      .post(`/service-requests/${serviceRequest.id}/phone-verification/verify`)
      .set('Cookie', cookie)
      .send({ code: TEST_CODE });
    expect(verified.status).toBe(201);
    expect(verified.body.phoneVerifiedAt).toBeTruthy();

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });
    expect(stored.phoneVerifiedAt).not.toBeNull();
    const row = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { requestId: serviceRequest.id },
    });
    expect(row.verifiedByTestBypass).toBe(true);
  });

  it('nothing on the way out carries the code or the list', async () => {
    arm();
    const { phone } = await standaloneFixture();
    const sent = await api().post('/showcase/lead-verification').send({ phone: OTHER_PHONE });
    const verified = await api()
      .post('/showcase/lead-verification/verify')
      .send({ phone, code: TEST_CODE });

    for (const body of [sent.body, verified.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(TEST_CODE);
      expect(text).not.toContain('5559980042');
      expect(text).not.toContain('1112233');
    }

    // The audit rows hold a masked recipient and no code — the SMS row for
    // the listed number is the same row any number gets.
    const logs = await ctx.prisma.notificationLog.findMany();
    for (const log of logs) {
      const text = JSON.stringify(log);
      expect(text).not.toContain(TEST_CODE);
      expect(text).not.toContain('5559980042');
    }
    const rows = await ctx.prisma.phoneVerification.findMany();
    for (const row of rows) {
      expect(row.codeHash).not.toBe(TEST_CODE);
    }
  });
});

describe('at boot', () => {
  it('stops a production process that carries the flag, naming the variable and not the value', () => {
    arm({ APP_ENVIRONMENT: 'production' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/PHONE_VERIFICATION_TEST_BYPASS_ENABLED/);
    try {
      assertPhoneVerificationTestBypassConfig();
    } catch (error) {
      expect((error as Error).message).not.toContain(TEST_CODE);
      expect((error as Error).message).not.toContain('5559980042');
    }

    arm({ NODE_ENV: 'production', APP_ENVIRONMENT: 'local' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/NODE_ENV/);

    arm({ APP_ENVIRONMENT: null });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/APP_ENVIRONMENT is not set/);
  });

  it('stops a permitted process whose contract is incomplete', () => {
    arm({ [VARS.expiresAt]: null });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/EXPIRES_AT/);

    arm({ [VARS.expiresAt]: 'yarın' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/ISO-8601/);

    arm({ [VARS.code]: '12' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/6 digits/);

    arm({ [VARS.phones]: '' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/PHONES/);
  });

  it('lets a lapsed period boot, off', () => {
    arm({ [VARS.expiresAt]: PAST });
    expect(() => assertPhoneVerificationTestBypassConfig()).not.toThrow();
    expect(isPhoneVerificationTestBypassMatch(TEST_PHONE, TEST_CODE)).toBe(false);
  });

  it('is silent when the flag is off, whatever else is set', () => {
    arm({ [VARS.enabled]: null, APP_ENVIRONMENT: 'production' });
    expect(() => assertPhoneVerificationTestBypassConfig()).not.toThrow();
  });

  it('refuses an APP_ENVIRONMENT that is none of the three', () => {
    arm({ APP_ENVIRONMENT: 'prod' });
    expect(() => assertPhoneVerificationTestBypassConfig()).toThrow(/APP_ENVIRONMENT must be one of/);
  });
});
