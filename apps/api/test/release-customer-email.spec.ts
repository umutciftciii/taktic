import { createHash, randomBytes } from 'node:crypto';
import { CustomerActivationDelivery, CustomerOrigin, NotificationStatus, Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isReleasedEmail, releasedCustomerEmail } from '../src/common/released-customer-email';
import { NotificationRetryService } from '../src/modules/notification-logs/notification-retry.service';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  applyRelease,
  applyRollback,
  inspect,
  parseArgs,
  planRelease,
  planRollback,
  ReleaseRefused,
  relationFingerprint,
  safeManifest,
  type ReleaseManifest,
} from '../src/scripts/release-customer-email';
import { applyRename } from '../src/scripts/super-admin-transition';
import { generateFixturePassword, TEST_ACCOUNT_PASSWORD } from './fixture-password';
import {
  createApprovedRequest,
  createCategory,
  createUser,
  createTestApp,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * STG-003B: releasing the address an unclaimed, request-created customer
 * account holds, against the real tables and — where the property is what a
 * person could do with an old link — the real HTTP routes.
 */

let ctx: TestContext;
let mail: TransactionalMailService;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(TransactionalMailService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
  resetAuthThrottle(ctx.app);
});

const ADDRESS = 'hedef.musteri@example.test';

function step<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ctx.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function readOnly<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return run(tx);
  });
}

async function refusalsOf(run: Promise<unknown>): Promise<string[]> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ReleaseRefused) return error.refusals;
    throw error;
  }
  throw new Error('expected the step to be refused');
}

/** The staging shape: request-created, no password, unproven, one request with the address as snapshot. */
async function seedUnclaimedCustomer(email = ADDRESS) {
  const customer = await createUser(ctx.prisma, {
    role: UserRole.CUSTOMER,
    email,
    password: null,
    customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
  });
  const category = await createCategory(ctx.prisma);
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
    customerEmail: email,
  });
  return { customer, serviceRequest };
}

function rawActivationToken() {
  const raw = randomBytes(24).toString('hex');
  return { raw, tokenHash: createHash('sha256').update(raw).digest('hex') };
}

async function issueOpenLinks(userId: string) {
  const activation = rawActivationToken();
  await ctx.prisma.customerActivationToken.create({
    data: {
      customerId: userId,
      tokenHash: activation.tokenHash,
      expiresAt: new Date(Date.now() + 3_600_000),
      delivery: CustomerActivationDelivery.EMAIL_DELIVERY,
    },
  });
  await ctx.prisma.passwordResetToken.create({
    data: { userId, tokenHash: `reset-${userId}-${Date.now()}`, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  await ctx.prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: `verify-${userId}-${Date.now()}`,
      emailSnapshot: ADDRESS,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return activation;
}

async function release(userId: string, email = ADDRESS) {
  return step((tx) => applyRelease(tx, { userId, email }));
}

describe('who can be released', () => {
  it('allows exactly the unclaimed request-created customer, named by id and address', async () => {
    const { customer } = await seedUnclaimedCustomer();
    expect(await readOnly((tx) => planRelease(tx, { userId: customer.id, email: ADDRESS }))).toEqual([]);
  });

  it('refuses the wrong account: an address it does not hold, or an id nobody has', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await seedUnclaimedCustomer('baska.musteri@example.test');

    const wrongAddress = await refusalsOf(release(customer.id, 'baska.musteri@example.test'));
    expect(wrongAddress.join(' ')).toMatch(/does not hold --email/);
    expect(await refusalsOf(release('cl_does_not_exist'))).toEqual(['no account has the --user-id']);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email).toBe(ADDRESS);
  });

  it.each([
    ['a registered customer', { customerOrigin: CustomerOrigin.REGISTERED }, /not created by a request/],
    ['a customer with a password', { password: TEST_ACCOUNT_PASSWORD }, /has a password/],
    ['a provider', { role: UserRole.PROVIDER, customerOrigin: null }, /not a CUSTOMER/],
    ['a super admin', { role: UserRole.SUPER_ADMIN, customerOrigin: null }, /not a CUSTOMER/],
  ])('refuses %s', async (_label, overrides, refusal) => {
    const account = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: ADDRESS,
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
      ...overrides,
    });
    expect((await refusalsOf(release(account.id))).join(' ')).toMatch(refusal);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: account.id } })).email).toBe(ADDRESS);
  });

  it('refuses an account whose address is proven', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await ctx.prisma.user.update({ where: { id: customer.id }, data: { emailVerifiedAt: new Date() } });
    expect((await refusalsOf(release(customer.id))).join(' ')).toMatch(/proven its address/);
  });

  it('inspect reads without writing and shows the address masked', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await issueOpenLinks(customer.id);
    const result = await readOnly((tx) => inspect(tx, { userId: customer.id, email: ADDRESS }));
    expect(result.account?.email).toBe('h***@example.test');
    expect(result.openLinks).toEqual({ activation: 1, passwordReset: 1, emailVerification: 1 });
    expect(result.refusals).toEqual([]);
    expect(result.placeholder).toBe(releasedCustomerEmail(customer.id));
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email).toBe(ADDRESS);
  });
});

describe('the release', () => {
  it('moves only the address, spends every link, revokes every session and keeps every relation', async () => {
    const { customer, serviceRequest } = await seedUnclaimedCustomer();
    await issueOpenLinks(customer.id);
    await loginAs(ctx.prisma, customer.id);
    const bystander = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'bystander@example.test' });
    const bystanderBefore = await ctx.prisma.user.findUniqueOrThrow({ where: { id: bystander.id } });
    const relationsBefore = await step((tx) => relationFingerprint(tx, customer.id));

    const manifest = await release(customer.id);

    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.email).toBe(releasedCustomerEmail(customer.id));
    expect(isReleasedEmail(after.email)).toBe(true);
    expect(after.emailVerifiedAt).toBeNull();
    expect(after.passwordHash).toBeNull();
    expect(after.role).toBe(UserRole.CUSTOMER);
    expect(after.customerOrigin).toBe(CustomerOrigin.AUTO_CREATED_REQUEST);

    expect(await ctx.prisma.customerActivationToken.count({ where: { customerId: customer.id, usedAt: null } })).toBe(0);
    expect(await ctx.prisma.passwordResetToken.count({ where: { userId: customer.id, usedAt: null } })).toBe(0);
    expect(await ctx.prisma.emailVerificationToken.count({ where: { userId: customer.id, usedAt: null } })).toBe(0);
    expect(await ctx.prisma.session.count({ where: { userId: customer.id, revokedAt: null } })).toBe(0);

    // The request, its snapshot address included, and every reference stay.
    const requestAfter = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } });
    expect(requestAfter).toEqual(serviceRequest);
    expect(await step((tx) => relationFingerprint(tx, customer.id))).toEqual(relationsBefore);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: bystander.id } })).toEqual(bystanderBefore);

    expect(manifest).toMatchObject({
      version: 1,
      action: 'release',
      userId: customer.id,
      before: { email: ADDRESS },
      after: { email: releasedCustomerEmail(customer.id) },
      emailVerifiedAt: null,
      revoked: { sessions: 1, activationLinks: 1, passwordResetLinks: 1, emailVerificationLinks: 1 },
    });
    // What the console prints carries no full address.
    expect(JSON.stringify(safeManifest(manifest))).not.toContain(ADDRESS);
  });

  it('frees the address for another account (the super-admin rename)', async () => {
    const { customer } = await seedUnclaimedCustomer();
    const superAdmin = await createUser(ctx.prisma, {
      role: UserRole.SUPER_ADMIN,
      email: 'admin@taktic.local',
      password: TEST_ACCOUNT_PASSWORD,
    });
    await release(customer.id);
    await step((tx) =>
      applyRename(tx, { fromId: superAdmin.id, targetEmail: ADDRESS, newPassword: generateFixturePassword() }),
    );
    const holder = await ctx.prisma.user.findUniqueOrThrow({ where: { email: ADDRESS } });
    expect(holder.id).toBe(superAdmin.id);
    expect(holder.role).toBe(UserRole.SUPER_ADMIN);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).role).toBe(UserRole.CUSTOMER);
  });

  it('is not repeatable: a second run is refused and changes nothing', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await release(customer.id);
    const once = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(await refusalsOf(release(customer.id))).toEqual(['the account is already released']);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).toEqual(once);
  });

  it('two concurrent releases: exactly one commits', async () => {
    const { customer } = await seedUnclaimedCustomer();
    const outcomes = await Promise.allSettled([release(customer.id), release(customer.id)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email).toBe(
      releasedCustomerEmail(customer.id),
    );
  });

  it('a claim landing first wins: the release is refused and the claimed account keeps its address', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await ctx.prisma.user.update({ where: { id: customer.id }, data: { passwordHash: 'claimed' } });
    expect((await refusalsOf(release(customer.id))).join(' ')).toMatch(/has a password/);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email).toBe(ADDRESS);
  });

  it('an activation link mailed to the old address no longer opens the account', async () => {
    const { customer } = await seedUnclaimedCustomer();
    const activation = await issueOpenLinks(customer.id);
    await release(customer.id);

    const response = await request(ctx.app.getHttpServer())
      .post('/auth/customer-activation')
      .send({ token: activation.raw, password: generateFixturePassword() });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.passwordHash).toBeNull();
    expect(after.emailVerifiedAt).toBeNull();
  });
});

describe('notifications after a release', () => {
  it('sends nothing more to the snapshot address and leaves the earlier log untouched', async () => {
    const { customer, serviceRequest } = await seedUnclaimedCustomer();
    await mail.sendRequestReceived(serviceRequest.id);
    expect(ctx.notifications.sent.map((message) => message.to)).toEqual([ADDRESS]);
    const earlier = await ctx.prisma.notificationLog.findFirstOrThrow({ where: { userId: customer.id } });

    await release(customer.id);
    ctx.notifications.clear();
    // The receipt again, addressed to the snapshot: the earlier row gives up
    // its dedupe key so the second attempt is a real send, not a DUPLICATE.
    await ctx.prisma.notificationLog.update({ where: { id: earlier.id }, data: { dedupeKey: 'kept-for-history' } });
    await mail.sendRequestReceived(serviceRequest.id);

    expect(ctx.notifications.sent).toHaveLength(0);
    const blocked = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { userId: customer.id, id: { not: earlier.id } },
    });
    expect(blocked.status).toBe(NotificationStatus.FAILED);
    expect(blocked.errorCode).toBe('RECIPIENT_RELEASED');
    expect(blocked.maskedRecipient).not.toContain(ADDRESS);
    expect(await ctx.prisma.notificationLog.findUniqueOrThrow({ where: { id: earlier.id } })).toMatchObject({
      status: NotificationStatus.SENT,
      errorCode: null,
    });
  });

  it('an admin retry of a mail that failed before the release stays unsent', async () => {
    const { customer, serviceRequest } = await seedUnclaimedCustomer();
    ctx.notifications.failNextSend = true;
    await mail.sendRequestReceived(serviceRequest.id);
    const failed = await ctx.prisma.notificationLog.findFirstOrThrow({ where: { userId: customer.id } });
    expect(failed.status).toBe(NotificationStatus.FAILED);

    await release(customer.id);
    const retried = await ctx.app.get(NotificationRetryService).retryNotification(failed.id);

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(retried.status).toBe(NotificationStatus.FAILED);
    expect(retried.errorCode).toBe('RECIPIENT_RELEASED');
  });

  it('mail for the account that now holds the address still goes out', async () => {
    const { customer } = await seedUnclaimedCustomer();
    const superAdmin = await createUser(ctx.prisma, {
      role: UserRole.SUPER_ADMIN,
      email: 'admin@taktic.local',
      password: TEST_ACCOUNT_PASSWORD,
    });
    await release(customer.id);
    await step((tx) =>
      applyRename(tx, { fromId: superAdmin.id, targetEmail: ADDRESS, newPassword: generateFixturePassword() }),
    );

    await mail.sendPasswordReset({
      userId: superAdmin.id,
      email: ADDRESS,
      fullName: null,
      resetUrl: 'https://example.test/sifre-sifirla?token=t',
      requestedAt: new Date(),
      expiryMinutes: 30,
    });
    expect(ctx.notifications.sent.map((message) => message.to)).toEqual([ADDRESS]);
  });

  it('a placeholder recipient is never handed to the transport', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await release(customer.id);
    await mail.sendPasswordReset({
      userId: null as never,
      email: releasedCustomerEmail(customer.id),
      fullName: null,
      resetUrl: 'https://example.test/sifre-sifirla?token=t',
      requestedAt: new Date(),
      expiryMinutes: 30,
    });
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});

describe('rollback', () => {
  it('gives the address back while nobody holds it; spent links stay spent', async () => {
    const { customer } = await seedUnclaimedCustomer();
    await issueOpenLinks(customer.id);
    const manifest = await release(customer.id);

    expect(await readOnly((tx) => planRollback(tx, manifest))).toEqual([]);
    const undone = await step((tx) => applyRollback(tx, manifest));

    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.email).toBe(ADDRESS);
    expect(after.emailVerifiedAt).toBeNull();
    expect(await ctx.prisma.customerActivationToken.count({ where: { customerId: customer.id, usedAt: null } })).toBe(0);
    expect(undone).toMatchObject({ action: 'rollback', after: { email: ADDRESS } });
    expect(undone.relations).toEqual(manifest.relations);
  });

  it('is refused once another account holds the address, and on a second run', async () => {
    const { customer } = await seedUnclaimedCustomer();
    const superAdmin = await createUser(ctx.prisma, {
      role: UserRole.SUPER_ADMIN,
      email: 'admin@taktic.local',
      password: TEST_ACCOUNT_PASSWORD,
    });
    const manifest: ReleaseManifest = await release(customer.id);
    await step((tx) =>
      applyRename(tx, { fromId: superAdmin.id, targetEmail: ADDRESS, newPassword: generateFixturePassword() }),
    );

    const held = await refusalsOf(step((tx) => applyRollback(tx, manifest)));
    expect(held.join(' ')).toMatch(/held by a SUPER_ADMIN account/);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: superAdmin.id } })).email).toBe(ADDRESS);

    // Address given back to nobody in particular: the rename is rolled back by hand here.
    await ctx.prisma.user.update({ where: { id: superAdmin.id }, data: { email: 'admin@taktic.local' } });
    await step((tx) => applyRollback(tx, manifest));
    expect((await refusalsOf(step((tx) => applyRollback(tx, manifest)))).join(' ')).toMatch(/no longer holds the placeholder/);
  });
});

describe('command line', () => {
  it('asks for the address twice and never applies inspect', () => {
    expect(() => parseArgs(['release', '--user-id', 'u1', '--email', ADDRESS])).toThrow(/--confirm-email/);
    expect(() =>
      parseArgs(['release', '--user-id', 'u1', '--email', ADDRESS, '--confirm-email', 'baska@example.test']),
    ).toThrow(/--confirm-email/);
    expect(() => parseArgs(['inspect', '--user-id', 'u1', '--email', ADDRESS, '--apply'])).toThrow(/only reads/);
    expect(() => parseArgs(['rollback'])).toThrow(/--manifest/);
    const cli = parseArgs(['release', '--user-id', 'u1', '--email', ' Hedef.Musteri@Example.TEST ', '--confirm-email', ADDRESS]);
    expect(cli).toMatchObject({ command: 'release', apply: false, email: ADDRESS });
  });
});
