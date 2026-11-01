import { Logger } from '@nestjs/common';
import { AdminPermission, OpsAlertChannel, OpsAlertDeliveryStatus, OpsAlertEmailRouting, OpsAlertNoticeKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANTABLE_ADMIN_PERMISSIONS, SUPER_ADMIN_RESERVED_PERMISSIONS } from '../src/modules/auth/admin-permissions';
import { ADMIN_ROUTE_PERMISSIONS } from '../src/modules/auth/route-permission-map';
import { composeTestNotice } from '../src/modules/ops-alerts/ops-alert.rules';
import { OpsAlertRoutingService } from '../src/modules/ops-alerts/ops-alert-routing.service';
import type { AuthUser } from '../src/modules/auth/auth.types';
import { decideRecipientRemoval } from '../src/modules/ops-alerts/ops-alert-recipient-guard';
import {
  DuplicateRecipientError,
  LastChannelProtectedError,
  LastCriticalConfirmationRequired,
  mapDatabaseError,
  OpsAlertRecipientsService,
  RecipientDeletedError,
  RecipientLimitReachedError,
  VersionConflictError,
} from '../src/modules/ops-alerts/ops-alert-recipients.service';
import { createAdminWithPermissions, createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * OBS-ALERT-002 — the managed recipient service: the address is stored only
 * encrypted, identity is the keyed hash, every mutation runs under the
 * recipient lock and writes its audit row in the same transaction.
 */
describe('OpsAlertRecipientsService', () => {
  let ctx: TestContext;
  let service: OpsAlertRecipientsService;
  let actor: AuthUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    service = ctx.app.get(OpsAlertRecipientsService);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Kök' });
    actor = {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      role: user.role,
      isActive: true,
    };
  });

  const prefs = { notifyWarning: true, notifyCritical: true, notifyRecovery: false };
  const add = (address: string, label = 'Nöbetçi') => service.create(actor, { address, label, ...prefs });

  async function pendingDelivery(recipientId: string, status: OpsAlertDeliveryStatus = OpsAlertDeliveryStatus.PENDING) {
    const now = new Date();
    const alert = await ctx.prisma.opsAlert.create({
      data: {
        ref: `OPS-A3-${Math.random().toString(36).slice(2)}`,
        fingerprint: `fp-${Math.random()}`,
        source: 'SCHEDULER',
        subjectKey: 'job',
        condition: 'OVERDUE',
        severity: 'CRITICAL',
        firstSeenAt: now,
        lastSeenAt: now,
        lastNotifiedAt: now,
      },
    });
    return ctx.prisma.opsAlertDelivery.create({
      data: {
        alertId: alert.id,
        kind: OpsAlertNoticeKind.OPENED,
        channel: OpsAlertChannel.EMAIL,
        recipientId,
        status,
        nextAttemptAt: now,
        ...(status === OpsAlertDeliveryStatus.SENDING ? { claimToken: 'claim', claimedAt: now } : {}),
      },
    });
  }

  it('create stores ciphertext and hmac, never the address', async () => {
    const view = await add('Umut@iCloud.com');
    expect(view.maskedAddress).toBe('u***@icloud.com');
    expect(view.status).toBe('ACTIVE');
    expect(view.version).toBe(1);
    expect(view.keyId).toBe('v1');
    expect(view.isLastCritical).toBe(true);
    expect(JSON.stringify(view)).not.toContain('umut@icloud.com');

    const rows = await ctx.prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "OpsAlertRecipient"`);
    expect(rows).toHaveLength(1);
    for (const value of Object.values(rows[0]!)) {
      const text = value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : JSON.stringify(value ?? '');
      expect(text.toLowerCase()).not.toContain('umut@icloud.com');
    }
    expect(rows[0]!.addressCiphertext).toBeInstanceOf(Uint8Array);
    expect(typeof rows[0]!.addressHmac).toBe('string');
  });

  it('create rejects a duplicate in another case', async () => {
    await add('umut@icloud.com');
    await expect(add('  UMUT@iCloud.COM ')).rejects.toBeInstanceOf(DuplicateRecipientError);
    await expect(add('UMUT@icloud.com')).rejects.toMatchObject({ code: 'RECIPIENT_DUPLICATE' });
    expect(await ctx.prisma.opsAlertRecipient.count()).toBe(1);
  });

  it('rejects the 11th recipient when two creates race', async () => {
    for (let i = 0; i < 9; i += 1) await add(`ops${i}@example.test`);
    const results = await Promise.allSettled([add('race-a@example.test'), add('race-b@example.test')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RecipientLimitReachedError);
    expect(rejected.reason.code).toBe('RECIPIENT_LIMIT');
    expect(await ctx.prisma.opsAlertRecipient.count({ where: { status: { not: 'DELETED' } } })).toBe(10);
  });

  it('a deleted recipient frees a slot and its address may be added again', async () => {
    const first = await add('again@example.test');
    for (let i = 0; i < 9; i += 1) await add(`ops${i}@example.test`);
    await expect(add('eleventh@example.test')).rejects.toBeInstanceOf(RecipientLimitReachedError);
    await service.remove(actor, first.id, { version: first.version, reason: 'Ayrıldı' });
    const again = await add('again@example.test');
    expect(again.id).not.toBe(first.id);
    expect(await ctx.prisma.opsAlertRecipient.count({ where: { status: { not: 'DELETED' } } })).toBe(10);
  });

  it('update with a stale version is refused', async () => {
    const view = await add('stale@example.test');
    const updated = await service.update(actor, view.id, { version: 1, label: 'Yeni etiket', notifyRecovery: true });
    expect(updated.version).toBe(2);
    expect(updated.label).toBe('Yeni etiket');
    expect(updated.notifyRecovery).toBe(true);
    await expect(service.update(actor, view.id, { version: 1, label: 'Eski' })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(service.update(actor, view.id, { version: 1, label: 'Eski' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('pause and resume change status, bump the version and audit', async () => {
    const view = await add('pause@example.test');
    const paused = await service.pause(actor, view.id, { version: 1, confirmLastCritical: true });
    expect(paused.status).toBe('PAUSED');
    expect(paused.isLastCritical).toBe(false);
    const resumed = await service.resume(actor, view.id, { version: paused.version });
    expect(resumed.status).toBe('ACTIVE');
    const actions = (await ctx.prisma.opsAlertRecipientAuditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((r) => r.action);
    expect(actions).toEqual(['CREATED', 'PAUSED', 'RESUMED']);
  });

  it('remove shreds ciphertext and hmac and records the reason', async () => {
    const view = await add('gone@example.test');
    const live = await pendingDelivery(view.id);
    await service.remove(actor, view.id, { version: 1, reason: 'Ekipten ayrıldı', confirmLastCritical: true });
    const row = await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.status).toBe('DELETED');
    expect(row.addressCiphertext).toBeNull();
    expect(row.addressNonce).toBeNull();
    expect(row.addressTag).toBeNull();
    expect(row.addressKeyId).toBeNull();
    expect(row.addressHmac).toBeNull();
    expect(row.addressHmacVersion).toBeNull();
    expect(row.deletedById).toBe(actor.id);
    expect(row.deletedAt).toBeInstanceOf(Date);
    const audit = await ctx.prisma.opsAlertRecipientAuditLog.findFirstOrThrow({ where: { action: 'DELETED' } });
    expect(audit.reason).toBe('Ekipten ayrıldı');
    expect(audit.recipientId).toBe(view.id);
    const cancelled = await ctx.prisma.opsAlertDelivery.findUniqueOrThrow({ where: { id: live.id } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.errorCode).toBe('RECIPIENT_REMOVED');
    expect(await service.list()).toHaveLength(0);
    await expect(service.update(actor, view.id, { version: row.version, label: 'x' })).rejects.toBeInstanceOf(RecipientDeletedError);
    await expect(service.reveal(actor, view.id)).rejects.toMatchObject({ code: 'RECIPIENT_DELETED' });
  });

  it('replaceAddress keeps no pending delivery on the new id', async () => {
    const old = await add('old@example.test', 'Etiket');
    const pending = await pendingDelivery(old.id);
    const sending = await pendingDelivery(old.id, OpsAlertDeliveryStatus.SENDING);
    const view = await service.replaceAddress(actor, old.id, { version: 1, address: 'New@Example.test', reason: 'Adres değişti' });
    expect(view.id).not.toBe(old.id);
    expect(view.label).toBe('Etiket');
    expect(view.maskedAddress).toBe('n**@example.test');
    expect(view.notifyWarning).toBe(true);
    expect(view.notifyRecovery).toBe(false);
    expect((await service.reveal(actor, view.id)).address).toBe('new@example.test');

    const oldRow = await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: old.id } });
    expect(oldRow.status).toBe('DELETED');
    expect(await ctx.prisma.opsAlertDelivery.count({ where: { recipientId: view.id } })).toBe(0);
    const cancelled = await ctx.prisma.opsAlertDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.errorCode).toBe('RECIPIENT_REMOVED');
    expect((await ctx.prisma.opsAlertDelivery.findUniqueOrThrow({ where: { id: sending.id } })).status).toBe('SENDING');

    const audit = await ctx.prisma.opsAlertRecipientAuditLog.findMany({ where: { action: 'ADDRESS_REPLACED' } });
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.recipientId).sort()).toEqual([old.id, view.id].sort());
  });

  it('replaceAddress refuses an address that is already live and leaves the old one intact', async () => {
    const a = await add('a@example.test');
    await add('b@example.test');
    await expect(service.replaceAddress(actor, a.id, { version: 1, address: 'B@example.test', reason: 'x' })).rejects.toBeInstanceOf(
      DuplicateRecipientError,
    );
    expect((await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('ACTIVE');
  });

  it('audit rows carry masked address only', async () => {
    const view = await add('secret.person@example.test');
    await service.update(actor, view.id, { version: 1, label: 'Başka' });
    await service.pause(actor, view.id, { version: 2, confirmLastCritical: true });
    await service.reveal(actor, view.id);
    const rows = await ctx.prisma.opsAlertRecipientAuditLog.findMany();
    const hmac = (await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: view.id } })).addressHmac!;
    const json = JSON.stringify(rows);
    expect(json).not.toContain('secret.person@example.test');
    expect(json).not.toContain(hmac);
    const created = rows.find((r) => r.action === 'CREATED')!;
    expect(created.before).toBeNull();
    expect(Object.keys(created.after as object).sort()).toEqual(
      ['label', 'maskedAddress', 'notifyCritical', 'notifyRecovery', 'notifyWarning', 'status'],
    );
    expect((created.after as Record<string, unknown>).maskedAddress).toBe('s************@example.test');
    const changed = rows.find((r) => r.action === 'LABEL_CHANGED')!;
    expect(changed.before).toEqual({ label: 'Nöbetçi' });
    expect(changed.after).toEqual({ label: 'Başka' });
  });

  it('reveal returns the address and writes REVEALED', async () => {
    const view = await add('Reveal.Me@example.test');
    const { address } = await service.reveal(actor, view.id);
    expect(address).toBe('reveal.me@example.test');
    const audit = await ctx.prisma.opsAlertRecipientAuditLog.findMany({ where: { action: 'REVEALED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(actor.id);
    expect(audit[0]!.recipientId).toBe(view.id);
    expect(JSON.stringify(audit)).not.toContain('reveal.me@example.test');
  });

  it('list derives delivery facts and isLastCritical', async () => {
    const a = await add('a@example.test');
    const b = await service.create(actor, { address: 'b@example.test', label: 'B', notifyWarning: true, notifyCritical: false, notifyRecovery: false });
    let views = await service.list();
    expect(views.find((v) => v.id === a.id)!.isLastCritical).toBe(true);
    expect(views.find((v) => v.id === b.id)!.isLastCritical).toBe(false);
    const sent = await pendingDelivery(a.id, OpsAlertDeliveryStatus.SENT);
    await ctx.prisma.opsAlertDelivery.update({ where: { id: sent.id }, data: { sentAt: new Date(Date.now() - 5000) } });
    const failed = await pendingDelivery(a.id, OpsAlertDeliveryStatus.FAILED);
    await ctx.prisma.opsAlertDelivery.update({ where: { id: failed.id }, data: { errorCode: 'TRANSPORT_UNAVAILABLE' } });
    views = await service.list();
    const view = views.find((v) => v.id === a.id)!;
    expect(view.lastSentAt).not.toBeNull();
    expect(view.lastErrorCode).toBe('TRANSPORT_UNAVAILABLE');
    expect(view.consecutiveFailures).toBe(1);
    await add('c@example.test');
    expect((await service.list()).every((v) => !v.isLastCritical)).toBe(true);
  });

  it('auditPage pages one recipient or all, newest first', async () => {
    const a = await add('a@example.test');
    await add('b@example.test');
    await service.pause(actor, a.id, { version: 1 });
    const one = await service.auditPage(a.id, {});
    expect(one.total).toBe(2);
    expect(one.items[0]!.action).toBe('PAUSED');
    expect(one.items[0]!.domain).toBe('OPS_ALERT_RECIPIENT');
    expect(one.items[0]!.actor?.id).toBe(actor.id);
    const all = await service.auditPage(null, { page: 1, pageSize: 2 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(2);
    expect(all.hasNextPage).toBe(true);
  });

  describe('database backstops (the service count bypassed)', () => {
    const row = (suffix: string, overrides: Record<string, unknown> = {}) => ({
      label: 'x',
      addressCiphertext: new Uint8Array([1]),
      addressNonce: new Uint8Array([1]),
      addressTag: new Uint8Array([1]),
      addressKeyId: 'v1',
      addressHmac: `backstop-${suffix}`,
      addressHmacVersion: 1,
      maskedAddress: 'a***@example.test',
      notifyWarning: true,
      notifyCritical: true,
      notifyRecovery: true,
      createdById: actor.id,
      updatedById: actor.id,
      ...overrides,
    });

    it('maps the limit trigger refusal (23514 + prefix) to RecipientLimitReachedError', async () => {
      for (let i = 0; i < 10; i += 1) await ctx.prisma.opsAlertRecipient.create({ data: row(String(i)) });
      const caught = await ctx.prisma
        .$transaction(async (tx) => tx.opsAlertRecipient.create({ data: row('eleventh') }))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(caught).not.toBeNull();
      expect(mapDatabaseError(caught)).toBeInstanceOf(RecipientLimitReachedError);
    });

    it('maps a live-HMAC unique violation to DuplicateRecipientError', async () => {
      await ctx.prisma.opsAlertRecipient.create({ data: row('same') });
      const caught = await ctx.prisma.opsAlertRecipient.create({ data: row('same') }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(mapDatabaseError(caught)).toBeInstanceOf(DuplicateRecipientError);
    });

    it('does not mistake another check violation for the limit', async () => {
      const caught = await ctx.prisma.opsAlertRecipient.create({ data: row('label', { label: '' }) }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).not.toBeNull();
      expect(mapDatabaseError(caught)).toBe(caught);
    });
  });

  describe('last critical recipient / last channel guard', () => {
    type Input = Parameters<typeof decideRecipientRemoval>[0];
    const base: Input = {
      environment: 'local',
      telegramConfigured: false,
      routing: OpsAlertEmailRouting.MANAGED,
      liveCriticalAfter: 0,
      touchesCritical: true,
      confirmed: false,
    };
    it.each<[string, Partial<Input>, 'ALLOW' | 'CONFIRM_REQUIRED' | 'BLOCKED']>([
      ['liveCriticalAfter >= 1', { liveCriticalAfter: 1, environment: 'production' }, 'ALLOW'],
      ['operation does not touch critical', { touchesCritical: false, environment: 'production' }, 'ALLOW'],
      ['MANAGED, 0 left, production, no telegram', { environment: 'production' }, 'BLOCKED'],
      ['MANAGED, 0 left, production, no telegram, confirmed', { environment: 'production', confirmed: true }, 'BLOCKED'],
      ['MANAGED, 0 left, production, telegram, unconfirmed', { environment: 'production', telegramConfigured: true }, 'CONFIRM_REQUIRED'],
      ['MANAGED, 0 left, production, telegram, confirmed', { environment: 'production', telegramConfigured: true, confirmed: true }, 'ALLOW'],
      ['MANAGED, 0 left, staging, no telegram, unconfirmed', { environment: 'staging' }, 'CONFIRM_REQUIRED'],
      ['MANAGED, 0 left, staging, no telegram, confirmed', { environment: 'staging', confirmed: true }, 'ALLOW'],
      ['MANAGED, 0 left, undeclared environment, no telegram, unconfirmed', { environment: null }, 'BLOCKED'],
      ['MANAGED, 0 left, undeclared environment, no telegram, confirmed', { environment: null, confirmed: true }, 'BLOCKED'],
      ['MANAGED, 0 left, undeclared environment, telegram, unconfirmed', { environment: null, telegramConfigured: true }, 'CONFIRM_REQUIRED'],
      ['ENV_LEGACY, 0 left, production, no telegram, unconfirmed', { routing: OpsAlertEmailRouting.ENV_LEGACY, environment: 'production' }, 'CONFIRM_REQUIRED'],
      ['ENV_LEGACY, 0 left, production, no telegram, confirmed', { routing: OpsAlertEmailRouting.ENV_LEGACY, environment: 'production', confirmed: true }, 'ALLOW'],
    ])('decides: %s', (_name, patch, expected) => {
      expect(decideRecipientRemoval({ ...base, ...patch })).toBe(expected);
    });

    const TELEGRAM_VARS = ['OPS_ALERT_TELEGRAM_BOT_TOKEN', 'OPS_ALERT_TELEGRAM_CHAT_ID'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of ['APP_ENVIRONMENT', ...TELEGRAM_VARS]) saved[key] = process.env[key];
      for (const key of TELEGRAM_VARS) delete process.env[key];
    });
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const withTelegram = () => {
      process.env.OPS_ALERT_TELEGRAM_BOT_TOKEN = `${'1'.repeat(6)}:${'x'.repeat(35)}`;
      process.env.OPS_ALERT_TELEGRAM_CHAT_ID = '-100222333444';
    };
    const setRouting = (emailRouting: OpsAlertEmailRouting) =>
      ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting } });

    it('production guard reads telegram status per request', async () => {
      process.env.APP_ENVIRONMENT = 'production';
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const only = await add('last@example.test');
      withTelegram();
      await expect(service.pause(actor, only.id, { version: only.version })).rejects.toBeInstanceOf(
        LastCriticalConfirmationRequired,
      );
      for (const key of TELEGRAM_VARS) delete process.env[key];
      await expect(
        service.pause(actor, only.id, { version: only.version, confirmLastCritical: true }),
      ).rejects.toBeInstanceOf(LastChannelProtectedError);
      const row = await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: only.id } });
      expect(row.status).toBe('ACTIVE');
    });

    it('pausing the last critical recipient with telegram present needs confirmation', async () => {
      process.env.APP_ENVIRONMENT = 'production';
      withTelegram();
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const only = await add('last@example.test');
      await expect(service.pause(actor, only.id, { version: only.version })).rejects.toBeInstanceOf(
        LastCriticalConfirmationRequired,
      );
      const paused = await service.pause(actor, only.id, { version: only.version, confirmLastCritical: true });
      expect(paused.status).toBe('PAUSED');
    });

    it('update turning notifyCritical off and remove need confirmation on the last critical recipient', async () => {
      process.env.APP_ENVIRONMENT = 'local';
      const only = await add('last@example.test');
      await expect(service.update(actor, only.id, { version: only.version, notifyCritical: false })).rejects.toBeInstanceOf(
        LastCriticalConfirmationRequired,
      );
      await expect(service.remove(actor, only.id, { version: only.version, reason: 'x' })).rejects.toBeInstanceOf(
        LastCriticalConfirmationRequired,
      );
      const updated = await service.update(actor, only.id, {
        version: only.version,
        notifyCritical: false,
        confirmLastCritical: true,
      });
      expect(updated.notifyCritical).toBe(false);
    });

    it('operations that keep a critical recipient, or do not touch one, never need confirmation', async () => {
      process.env.APP_ENVIRONMENT = 'production';
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const a = await add('a@example.test');
      const b = await add('b@example.test');
      const quiet = await service.create(actor, { address: 'q@example.test', label: 'q', notifyWarning: true, notifyCritical: false, notifyRecovery: false });
      // another critical recipient remains
      await service.pause(actor, a.id, { version: a.version });
      // warning-only recipient touches no critical
      await service.pause(actor, quiet.id, { version: quiet.version });
      await service.remove(actor, quiet.id, { version: quiet.version + 1, reason: 'x' });
      // replacing the last critical recipient's address keeps it critical
      const replaced = await service.replaceAddress(actor, b.id, { version: b.version, address: 'b2@example.test', reason: 'moved' });
      expect(replaced.notifyCritical).toBe(true);
    });

    it('two concurrent removals of the last two critical recipients: exactly one succeeds in production without telegram', async () => {
      process.env.APP_ENVIRONMENT = 'production';
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const a = await add('a@example.test');
      const b = await add('b@example.test');
      const results = await Promise.allSettled([
        service.remove(actor, a.id, { version: a.version, reason: 'x', confirmLastCritical: true }),
        service.remove(actor, b.id, { version: b.version, reason: 'x', confirmLastCritical: true }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(LastChannelProtectedError);
      const live = await ctx.prisma.opsAlertRecipient.count({ where: { status: { not: 'DELETED' } } });
      expect(live).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP: the recipient and routing endpoints (OBS-ALERT-002 A9)
// ---------------------------------------------------------------------------

describe('OBS-ALERT-002 HTTP endpoints', () => {
  let ctx: TestContext;
  let service: OpsAlertRecipientsService;
  let routing: OpsAlertRoutingService;
  let root: AuthUser;
  let rootCookie: string;

  const ENV_ADDRESS = 'env.ops@example.test';
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['OPS_ALERT_EMAIL', 'APP_ENVIRONMENT', 'OPS_ALERT_TELEGRAM_BOT_TOKEN', 'OPS_ALERT_TELEGRAM_CHAT_ID'] as const;

  beforeAll(async () => {
    ctx = await createTestApp();
    service = ctx.app.get(OpsAlertRecipientsService);
    routing = ctx.app.get(OpsAlertRoutingService);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.OPS_ALERT_EMAIL = ENV_ADDRESS;
    process.env.APP_ENVIRONMENT = 'local';
    delete process.env.OPS_ALERT_TELEGRAM_BOT_TOKEN;
    delete process.env.OPS_ALERT_TELEGRAM_CHAT_ID;
    await resetDatabase(ctx.prisma);
    ctx.notifications.clear();
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Kök' });
    root = { id: user.id, email: user.email, phone: user.phone, name: user.name, role: user.role, isActive: true };
    rootCookie = await loginAs(ctx.prisma, user.id);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const quietPrefs = { notifyWarning: true, notifyCritical: false, notifyRecovery: false };
  const seed = (address: string, label = 'Nöbetçi', prefs = quietPrefs) => service.create(root, { address, label, ...prefs });

  type Verb = 'get' | 'post' | 'patch' | 'delete';
  const call = (verb: Verb, path: string, cookie: string | null, body?: object) => {
    const req = request(ctx.server)[verb](path);
    if (cookie) req.set('Cookie', cookie);
    return body === undefined ? req : req.send(body);
  };

  async function adminCookie(permissions: AdminPermission[]) {
    const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
    return loginAs(ctx.prisma, admin.id);
  }

  async function openAlertWithDelivery(recipientId: string | null, channel: OpsAlertChannel = OpsAlertChannel.EMAIL) {
    const now = new Date();
    const alert = await ctx.prisma.opsAlert.create({
      data: {
        ref: `OPS-A9-${Math.random().toString(36).slice(2, 8)}`,
        fingerprint: `fp-${Math.random()}`,
        source: 'SCHEDULER',
        subjectKey: 'unviewed-offer-refund',
        condition: 'OVERDUE',
        severity: 'CRITICAL',
        firstSeenAt: now,
        lastSeenAt: now,
        lastNotifiedAt: now,
      },
    });
    const delivery = await ctx.prisma.opsAlertDelivery.create({
      data: { alertId: alert.id, kind: OpsAlertNoticeKind.OPENED, channel, recipientId, status: OpsAlertDeliveryStatus.PENDING, nextAttemptAt: now },
    });
    return { alert, delivery };
  }

  // -------------------------------------------------------------------------
  // The RBAC matrix
  // -------------------------------------------------------------------------

  type Prepared = { path: string; body?: object };
  type RouteCase = {
    name: string;
    verb: Verb;
    needs: AdminPermission[];
    /** Reserved for SUPER_ADMIN: an ADMIN holding it through a role is still refused. */
    reserved?: boolean;
    prepare: () => Promise<Prepared>;
  };

  const P = AdminPermission;
  const ROUTES: RouteCase[] = [
    { name: 'GET /ops-alerts/recipients', verb: 'get', needs: [P.OPS_ALERT_RECIPIENTS_READ], prepare: async () => ({ path: '/ops-alerts/recipients' }) },
    {
      name: 'POST /ops-alerts/recipients',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_WRITE],
      prepare: async () => ({ path: '/ops-alerts/recipients', body: { address: 'new.one@example.test', label: 'Yeni', ...quietPrefs } }),
    },
    { name: 'GET /ops-alerts/recipients/audit', verb: 'get', needs: [P.OPS_ALERT_RECIPIENTS_READ], prepare: async () => ({ path: '/ops-alerts/recipients/audit' }) },
    {
      name: 'PATCH /ops-alerts/recipients/:id',
      verb: 'patch',
      needs: [P.OPS_ALERT_RECIPIENTS_WRITE],
      prepare: async () => {
        const r = await seed('patch@example.test');
        return { path: `/ops-alerts/recipients/${r.id}`, body: { version: r.version, label: 'Değişti' } };
      },
    },
    {
      name: 'DELETE /ops-alerts/recipients/:id',
      verb: 'delete',
      needs: [P.OPS_ALERT_RECIPIENTS_DELETE],
      prepare: async () => {
        const r = await seed('delete@example.test');
        return { path: `/ops-alerts/recipients/${r.id}`, body: { version: r.version, reason: 'Ekipten ayrıldı' } };
      },
    },
    {
      name: 'POST /ops-alerts/recipients/:id/pause',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_WRITE],
      prepare: async () => {
        const r = await seed('pause@example.test');
        return { path: `/ops-alerts/recipients/${r.id}/pause`, body: { version: r.version } };
      },
    },
    {
      name: 'POST /ops-alerts/recipients/:id/resume',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_WRITE],
      prepare: async () => {
        const r = await seed('resume@example.test');
        const paused = await service.pause(root, r.id, { version: r.version });
        return { path: `/ops-alerts/recipients/${r.id}/resume`, body: { version: paused.version } };
      },
    },
    {
      name: 'POST /ops-alerts/recipients/:id/replace-address',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_WRITE, P.OPS_ALERT_RECIPIENTS_DELETE],
      prepare: async () => {
        const r = await seed('replace@example.test');
        return {
          path: `/ops-alerts/recipients/${r.id}/replace-address`,
          body: { version: r.version, address: 'replaced@example.test', reason: 'Adres değişti' },
        };
      },
    },
    {
      name: 'POST /ops-alerts/recipients/:id/reveal',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_REVEAL],
      prepare: async () => ({ path: `/ops-alerts/recipients/${(await seed('reveal@example.test')).id}/reveal`, body: {} }),
    },
    {
      name: 'POST /ops-alerts/recipients/:id/test',
      verb: 'post',
      needs: [P.OPS_ALERT_RECIPIENTS_TEST],
      prepare: async () => ({ path: `/ops-alerts/recipients/${(await seed('test@example.test')).id}/test`, body: {} }),
    },
    {
      name: 'GET /ops-alerts/recipients/:id/audit',
      verb: 'get',
      needs: [P.OPS_ALERT_RECIPIENTS_READ],
      prepare: async () => ({ path: `/ops-alerts/recipients/${(await seed('audit@example.test')).id}/audit` }),
    },
    { name: 'GET /ops-alerts/routing', verb: 'get', needs: [P.OPS_ALERT_RECIPIENTS_READ], prepare: async () => ({ path: '/ops-alerts/routing' }) },
    {
      name: 'POST /ops-alerts/routing/import-env',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => ({ path: '/ops-alerts/routing/import-env', body: {} }),
    },
    {
      name: 'POST /ops-alerts/routing/cutover/preview',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => ({ path: '/ops-alerts/routing/cutover/preview', body: {} }),
    },
    {
      name: 'POST /ops-alerts/routing/cutover',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => {
        await seed('critical@example.test', 'Kritik', { notifyWarning: true, notifyCritical: true, notifyRecovery: true });
        const preview = await routing.previewCutover();
        return { path: '/ops-alerts/routing/cutover', body: { token: preview.token } };
      },
    },
    {
      name: 'POST /ops-alerts/routing/revert/preview',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => ({ path: '/ops-alerts/routing/revert/preview', body: {} }),
    },
    {
      name: 'POST /ops-alerts/routing/revert',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => {
        await ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting: OpsAlertEmailRouting.MANAGED } });
        const preview = await routing.previewRevert();
        return { path: '/ops-alerts/routing/revert', body: { token: preview.token, cancelUnmatched: true } };
      },
    },
    {
      name: 'POST /ops-alerts/routing/rewrap',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => ({ path: '/ops-alerts/routing/rewrap', body: {} }),
    },
    {
      name: 'POST /ops-alerts/routing/rehash',
      verb: 'post',
      needs: [P.OPS_ALERT_ROUTING_MANAGE],
      reserved: true,
      prepare: async () => ({ path: '/ops-alerts/routing/rehash', body: {} }),
    },
  ];

  it('route map covers every new route', () => {
    const mapped = new Set(ADMIN_ROUTE_PERMISSIONS.map((entry) => `${entry.method} ${entry.path}`));
    for (const route of ROUTES) expect(mapped.has(route.name), route.name).toBe(true);
    const replace = ADMIN_ROUTE_PERMISSIONS.find((entry) => entry.path === '/ops-alerts/recipients/:id/replace-address')!;
    expect([replace.permission, ...(replace.alsoRequires ?? [])].sort()).toEqual(
      [P.OPS_ALERT_RECIPIENTS_DELETE, P.OPS_ALERT_RECIPIENTS_WRITE].sort(),
    );
  });

  it.each(ROUTES.map((route) => [route.name, route] as const))('%s: an ADMIN without the permission gets 403', async (_name, route) => {
    const { path, body } = await route.prepare();
    // Everything grantable except what this route needs: the strongest refusal.
    const cookie = await adminCookie(GRANTABLE_ADMIN_PERMISSIONS.filter((p) => !route.needs.includes(p)));
    const response = await call(route.verb, path, cookie, body);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it.each(ROUTES.map((route) => [route.name, route] as const))('%s: the right ADMIN gets 2xx (403 when reserved)', async (_name, route) => {
    const { path, body } = await route.prepare();
    // A reserved permission smuggled in through a role row grants nothing.
    const cookie = await adminCookie(route.needs);
    const response = await call(route.verb, path, cookie, body);
    if (route.reserved) {
      expect(response.status).toBe(403);
    } else {
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    }
  });

  it.each(ROUTES.map((route) => [route.name, route] as const))('%s: SUPER_ADMIN gets 2xx', async (_name, route) => {
    const { path, body } = await route.prepare();
    const response = await call(route.verb, path, rootCookie, body);
    expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
  });

  it('refuses anonymous and customer callers', async () => {
    await call('get', '/ops-alerts/recipients', null).expect(401);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const response = await call('get', '/ops-alerts/recipients', await loginAs(ctx.prisma, customer.id));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_STAFF');
  });

  it('replace-address needs DELETE as well as WRITE', async () => {
    const r = await seed('replace@example.test');
    const body = { version: r.version, address: 'replaced@example.test', reason: 'Adres değişti' };
    const writeOnly = await adminCookie([P.OPS_ALERT_RECIPIENTS_WRITE]);
    expect((await call('post', `/ops-alerts/recipients/${r.id}/replace-address`, writeOnly, body)).status).toBe(403);
    const deleteOnly = await adminCookie([P.OPS_ALERT_RECIPIENTS_DELETE]);
    expect((await call('post', `/ops-alerts/recipients/${r.id}/replace-address`, deleteOnly, body)).status).toBe(403);
    expect((await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('ACTIVE');
  });

  it('OPS_ALERT_ROUTING_MANAGE is reserved: the role editor refuses it and the catalogue lists it as reserved', async () => {
    expect(SUPER_ADMIN_RESERVED_PERMISSIONS).toContain(P.OPS_ALERT_ROUTING_MANAGE);
    expect(GRANTABLE_ADMIN_PERMISSIONS).not.toContain(P.OPS_ALERT_ROUTING_MANAGE);
    const catalogue = await call('get', '/admin/permissions', rootCookie).expect(200);
    expect(catalogue.body.permissions).not.toContain('OPS_ALERT_ROUTING_MANAGE');
    expect(catalogue.body.reservedForSuperAdmin).toContain('OPS_ALERT_ROUTING_MANAGE');
    const created = await call('post', '/admin/roles', rootCookie, {
      key: `routing-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Yönlendirme',
      permissions: ['OPS_ALERT_ROUTING_MANAGE'],
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('PERMISSION_RESERVED_FOR_SUPER_ADMIN');
  });

  // -------------------------------------------------------------------------
  // Projection, reveal, test send
  // -------------------------------------------------------------------------

  it('list never returns ciphertext, nonce, tag or hmac', async () => {
    await seed('Projection.Person@example.test');
    const response = await call('get', '/ops-alerts/recipients', rootCookie).expect(200);
    expect(response.body).toHaveLength(1);
    expect(Object.keys(response.body[0]).sort()).toEqual(
      [
        'consecutiveFailures',
        'createdAt',
        'id',
        'isLastCritical',
        'keyId',
        'label',
        'lastErrorCode',
        'lastSentAt',
        'maskedAddress',
        'notifyCritical',
        'notifyRecovery',
        'notifyWarning',
        'status',
        'updatedAt',
        'version',
      ].sort(),
    );
    const row = await ctx.prisma.opsAlertRecipient.findFirstOrThrow();
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('projection.person@example.test');
    expect(text).not.toContain(row.addressHmac!);
    expect(text).not.toMatch(/ciphertext|nonce|addressTag|hmac/i);
  });

  it('create answers 201 with the masked view and the same key set', async () => {
    const response = await call('post', '/ops-alerts/recipients', rootCookie, {
      address: '  New.Person@Example.test ',
      label: '  Nöbetçi  ',
      notifyWarning: true,
      notifyCritical: true,
      notifyRecovery: true,
    }).expect(201);
    expect(response.body).toMatchObject({ label: 'Nöbetçi', maskedAddress: 'n*********@example.test', status: 'ACTIVE', version: 1 });
    expect(JSON.stringify(response.body)).not.toContain('new.person@example.test');
  });

  it('reveal sets no-store and audits every reveal', async () => {
    const r = await seed('Reveal.Me@example.test');
    const cookie = await adminCookie([P.OPS_ALERT_RECIPIENTS_REVEAL]);
    const response = await call('post', `/ops-alerts/recipients/${r.id}/reveal`, cookie, {}).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ address: 'reveal.me@example.test' });
    await call('post', `/ops-alerts/recipients/${r.id}/reveal`, cookie, {}).expect(200);
    expect(await ctx.prisma.opsAlertRecipientAuditLog.count({ where: { action: 'REVEALED', recipientId: r.id } })).toBe(2);
  });

  it('test send goes synchronously to the recipient, hidden in logs, and audits a closed result', async () => {
    const r = await seed('tester@example.test');
    const response = await call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}).expect(200);
    expect(response.body).toEqual({ result: 'SENT' });
    const sent = ctx.notifications.ofTemplate('ops-alert');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('tester@example.test');
    expect(sent[0]!.recipientLogPolicy).toBe('hidden');
    expect(sent[0]!.data?.subjectLabel).toBe('Test bildirimi');
    expect(sent[0]!.data?.alertRef).toBe('');
    const audit = await ctx.prisma.opsAlertRecipientAuditLog.findFirstOrThrow({ where: { action: 'TEST_SENT' } });
    expect(sent[0]!.idempotencyKey).toBe(`taktic-ops-alert-test-${audit.id}`);
    expect(audit.recipientId).toBe(r.id);
    expect(audit.actorId).toBe(root.id);
    expect(audit.after).toEqual({ result: 'SENT' });
    expect(JSON.stringify(audit)).not.toContain('tester@example.test');
    const page = await call('get', `/ops-alerts/recipients/${r.id}/audit`, rootCookie).expect(200);
    expect(page.body.items[0]).toMatchObject({ action: 'TEST_SENT', changes: [{ field: 'result', from: null, to: 'SENT' }] });
  });

  it('test send records the transport failure code and still answers', async () => {
    const r = await seed('tester@example.test');
    ctx.notifications.failNextSend = true;
    const response = await call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}).expect(200);
    expect(response.body).toEqual({ result: 'TRANSPORT_UNAVAILABLE' });
    const audit = await ctx.prisma.opsAlertRecipientAuditLog.findFirstOrThrow({ where: { action: 'TEST_SENT' } });
    expect(audit.after).toEqual({ result: 'TRANSPORT_UNAVAILABLE' });
  });

  it('test send works for a PAUSED recipient and refuses a DELETED one with 409', async () => {
    const paused = await seed('paused@example.test');
    await service.pause(root, paused.id, { version: paused.version });
    await call('post', `/ops-alerts/recipients/${paused.id}/test`, rootCookie, {}).expect(200);
    const gone = await seed('gone@example.test');
    await service.remove(root, gone.id, { version: gone.version, reason: 'Ayrıldı' });
    const response = await call('post', `/ops-alerts/recipients/${gone.id}/test`, rootCookie, {}).expect(409);
    expect(response.body.code).toBe('RECIPIENT_DELETED');
    await call('post', '/ops-alerts/recipients/does-not-exist/test', rootCookie, {}).expect(404);
  });

  it('test send is rate limited', async () => {
    // The audit log is append-only, so time is moved by seeding rows in the past.
    const r = await seed('tester@example.test');
    const other = await seed('other@example.test');
    const third = await seed('third@example.test');
    const at = (msAgo: number) => new Date(Date.now() - msAgo);
    const seedTests = (recipientId: string, count: number, createdAt: Date) =>
      ctx.prisma.opsAlertRecipientAuditLog.createMany({
        data: Array.from({ length: count }, () => ({ recipientId, actorId: root.id, action: 'TEST_SENT' as const, createdAt })),
      });

    // Rows older than an hour count for nothing.
    await seedTests(r.id, 20, at(61 * 60_000));
    await call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}).expect(200);
    const again = await call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}).expect(429);
    expect(again.body.code).toBe('TEST_RATE_LIMITED');
    expect(typeof again.body.message).toBe('string');
    expect(ctx.notifications.ofTemplate('ops-alert')).toHaveLength(1);

    // A test more than a minute ago does not hold the same recipient back.
    await seedTests(other.id, 1, at(61_000));
    await call('post', `/ops-alerts/recipients/${other.id}/test`, rootCookie, {}).expect(200);

    // Ten in the last hour across all recipients stop the next one, wherever it goes.
    await seedTests(r.id, 7, at(30 * 60_000));
    expect(await ctx.prisma.opsAlertRecipientAuditLog.count({ where: { action: 'TEST_SENT', createdAt: { gt: at(60 * 60_000) } } })).toBe(10);
    const limited = await call('post', `/ops-alerts/recipients/${third.id}/test`, rootCookie, {}).expect(429);
    expect(limited.body.code).toBe('TEST_RATE_LIMITED');
    expect(ctx.notifications.ofTemplate('ops-alert')).toHaveLength(2);
  });

  it('two concurrent test sends to one recipient: exactly one is sent', async () => {
    const r = await seed('tester@example.test');
    const results = await Promise.all([
      call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}),
      call('post', `/ops-alerts/recipients/${r.id}/test`, rootCookie, {}),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 429]);
    expect(ctx.notifications.ofTemplate('ops-alert')).toHaveLength(1);
    expect(await ctx.prisma.opsAlertRecipientAuditLog.count({ where: { action: 'TEST_SENT' } })).toBe(1);
  });

  it('composeTestNotice is a synthetic notice with no alert reference', () => {
    const notice = composeTestNotice('https://admin.example.test/system-health');
    expect(notice.emailData.subjectLabel).toBe('Test bildirimi');
    expect(notice.emailData.alertRef).toBe('');
    expect(notice.emailData.adminUrl).toBe('https://admin.example.test/system-health');
    expect(JSON.stringify(notice)).not.toMatch(/OPS-/);
    expect(notice.telegramText).toContain('Test bildirimi');
    expect(composeTestNotice(null).emailData.adminUrl).toBe('');
  });

  // -------------------------------------------------------------------------
  // HTTP mapping and validation
  // -------------------------------------------------------------------------

  it('maps the service refusals to 409 with a stable code and no values', async () => {
    const r = await seed('dupe@example.test');
    const dup = await call('post', '/ops-alerts/recipients', rootCookie, { address: 'DUPE@example.test', label: 'x', ...quietPrefs }).expect(409);
    expect(dup.body.code).toBe('RECIPIENT_DUPLICATE');
    expect(JSON.stringify(dup.body)).not.toContain('dupe@example.test');

    const stale = await call('patch', `/ops-alerts/recipients/${r.id}`, rootCookie, { version: r.version + 5, label: 'x' }).expect(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    for (let i = 0; i < 9; i += 1) await seed(`fill${i}@example.test`);
    const limit = await call('post', '/ops-alerts/recipients', rootCookie, { address: 'eleven@example.test', label: 'x', ...quietPrefs }).expect(409);
    expect(limit.body.code).toBe('RECIPIENT_LIMIT');

    const missing = await call('patch', '/ops-alerts/recipients/nope', rootCookie, { version: 1, label: 'x' }).expect(404);
    expect(missing.body.code).toBe('RECIPIENT_NOT_FOUND');
    for (const body of [dup.body, stale.body, limit.body, missing.body]) expect(typeof body.message).toBe('string');
  });

  it('asks for confirmation before the last critical recipient goes, and blocks the last channel in production', async () => {
    const r = await seed('last@example.test', 'Son', { notifyWarning: true, notifyCritical: true, notifyRecovery: true });
    const confirm = await call('post', `/ops-alerts/recipients/${r.id}/pause`, rootCookie, { version: r.version }).expect(409);
    expect(confirm.body.code).toBe('LAST_CRITICAL_CONFIRM_REQUIRED');
    process.env.APP_ENVIRONMENT = 'production';
    await ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting: OpsAlertEmailRouting.MANAGED } });
    const blocked = await call('delete', `/ops-alerts/recipients/${r.id}`, rootCookie, {
      version: r.version,
      reason: 'Ekipten ayrıldı',
      confirmLastCritical: true,
    }).expect(409);
    expect(blocked.body.code).toBe('LAST_CHANNEL_PROTECTED');
    process.env.APP_ENVIRONMENT = 'local';
    await call('post', `/ops-alerts/recipients/${r.id}/pause`, rootCookie, { version: r.version, confirmLastCritical: true }).expect(200);
  });

  it('maps the routing refusals to 409', async () => {
    const bogus = 'a'.repeat(64);
    const changed = await call('post', '/ops-alerts/routing/cutover', rootCookie, { token: bogus });
    expect(changed.status).toBe(409);
    // No critical recipient yet: the cutover is blocked before the token is looked at.
    expect(changed.body.code).toBe('NO_LIVE_CRITICAL_CHANNEL');

    await seed('critical@example.test', 'Kritik', { notifyWarning: true, notifyCritical: true, notifyRecovery: true });
    const counts = await call('post', '/ops-alerts/routing/cutover', rootCookie, { token: bogus }).expect(409);
    expect(counts.body.code).toBe('COUNTS_CHANGED');

    delete process.env.OPS_ALERT_EMAIL;
    const missing = await call('post', '/ops-alerts/routing/import-env', rootCookie, {}).expect(409);
    expect(missing.body.code).toBe('ENV_ADDRESS_MISSING');
    process.env.OPS_ALERT_EMAIL = ENV_ADDRESS;
    await call('post', '/ops-alerts/routing/import-env', rootCookie, {}).expect(201);
    const again = await call('post', '/ops-alerts/routing/import-env', rootCookie, {}).expect(409);
    expect(again.body.code).toBe('RECIPIENT_DUPLICATE');

    const already = await call('post', '/ops-alerts/routing/revert', rootCookie, { token: bogus, cancelUnmatched: true }).expect(409);
    expect(already.body.code).toBe('ALREADY_IN_MODE');
  });

  it('revert refuses to cancel pending deliveries without confirmation', async () => {
    const other = await seed('other@example.test');
    await ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting: OpsAlertEmailRouting.MANAGED } });
    await openAlertWithDelivery(other.id);
    const preview = await call('post', '/ops-alerts/routing/revert/preview', rootCookie, {}).expect(200);
    expect(preview.body.counts.PENDING.cancel).toBe(1);
    const refused = await call('post', '/ops-alerts/routing/revert', rootCookie, { token: preview.body.token }).expect(409);
    expect(refused.body.code).toBe('CONFIRM_CANCEL_REQUIRED');
    const state = await call('post', '/ops-alerts/routing/revert', rootCookie, { token: preview.body.token, cancelUnmatched: true }).expect(200);
    expect(state.body.emailRouting).toBe('ENV_LEGACY');
  });

  it.each<[string, Verb, (id: string, version: number) => string, object]>([
    ['empty label', 'post', () => '/ops-alerts/recipients', { address: 'x@example.test', label: '   ', ...quietPrefs }],
    ['label over 80', 'post', () => '/ops-alerts/recipients', { address: 'x@example.test', label: 'x'.repeat(81), ...quietPrefs }],
    ['address over 254', 'post', () => '/ops-alerts/recipients', { address: `${'a'.repeat(250)}@example.test`, label: 'x', ...quietPrefs }],
    ['malformed address', 'post', () => '/ops-alerts/recipients', { address: 'Ad Soyad <x@example.test>', label: 'x', ...quietPrefs }],
    ['string boolean', 'post', () => '/ops-alerts/recipients', { address: 'x@example.test', label: 'x', ...quietPrefs, notifyWarning: 'true' }],
    ['missing preference', 'post', () => '/ops-alerts/recipients', { address: 'x@example.test', label: 'x', notifyWarning: true, notifyCritical: true }],
    ['unknown field', 'post', () => '/ops-alerts/recipients', { address: 'x@example.test', label: 'x', ...quietPrefs, status: 'ACTIVE' }],
    ['version zero', 'patch', (id) => `/ops-alerts/recipients/${id}`, { version: 0, label: 'x' }],
    ['version as text', 'patch', (id) => `/ops-alerts/recipients/${id}`, { version: '1', label: 'x' }],
    ['address in patch', 'patch', (id, v) => `/ops-alerts/recipients/${id}`, { version: 1, address: 'y@example.test' }],
    ['delete without reason', 'delete', (id) => `/ops-alerts/recipients/${id}`, { version: 1 }],
    ['delete with short reason', 'delete', (id) => `/ops-alerts/recipients/${id}`, { version: 1, reason: '  abc  ' }],
    ['delete with long reason', 'delete', (id) => `/ops-alerts/recipients/${id}`, { version: 1, reason: 'x'.repeat(501) }],
    ['replace without reason', 'post', (id) => `/ops-alerts/recipients/${id}/replace-address`, { version: 1, address: 'y@example.test' }],
    ['pause with string confirm', 'post', (id) => `/ops-alerts/recipients/${id}/pause`, { version: 1, confirmLastCritical: 'yes' }],
    ['cutover without token', 'post', () => '/ops-alerts/routing/cutover', {}],
    ['revert with string cancel', 'post', () => '/ops-alerts/routing/revert', { token: 'a'.repeat(64), cancelUnmatched: 'true' }],
  ])('rejects %s with 400', async (_name, verb, path, body) => {
    const r = await seed('valid@example.test');
    const response = await call(verb, path(r.id, r.version), rootCookie, body);
    expect(response.status).toBe(400);
    expect((await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: r.id } })).version).toBe(1);
    expect(await ctx.prisma.opsAlertRecipient.count()).toBe(1);
  });

  it('writes no address into any log line', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    try {
      const created = await call('post', '/ops-alerts/recipients', rootCookie, { address: 'Logged.Never@example.test', label: 'x', ...quietPrefs }).expect(201);
      await call('post', `/ops-alerts/recipients/${created.body.id}/reveal`, rootCookie, {}).expect(200);
      ctx.notifications.failNextSend = true;
      await call('post', `/ops-alerts/recipients/${created.body.id}/test`, rootCookie, {}).expect(200);
      await call('post', '/ops-alerts/recipients', rootCookie, { address: 'logged.never@example.test', label: 'x', ...quietPrefs }).expect(409);
      await call('post', `/ops-alerts/recipients/${created.body.id}/replace-address`, rootCookie, {
        version: 1,
        address: 'Next.Logged@example.test',
        reason: 'Adres değişti',
      }).expect(200);
      const lines = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      for (const line of lines) {
        expect(line.toLowerCase()).not.toContain('logged.never@example.test');
        expect(line.toLowerCase()).not.toContain('next.logged@example.test');
        expect(line).not.toMatch(/l\*+@example\.test|n\*+@example\.test/);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // The system health report
  // -------------------------------------------------------------------------

  it('system health report lists recipient labels, never addresses', async () => {
    const r = await seed('Health.Person@example.test', 'Nöbetçi Ayşe');
    await seed('second@example.test', 'İkinci');
    const gone = await seed('gone@example.test', 'Giden');
    await service.remove(root, gone.id, { version: gone.version, reason: 'Ayrıldı' });
    await openAlertWithDelivery(r.id);
    await openAlertWithDelivery(null, OpsAlertChannel.TELEGRAM);
    const response = await call('get', '/system-health', await adminCookie([P.OPERATIONS_SETTINGS_READ])).expect(200);
    const block = response.body.alerts;
    expect(block.channels).toEqual({ email: true, telegram: false, emailRouting: 'ENV_LEGACY', managedRecipients: 2 });
    const deliveries = block.open.flatMap((alert: { deliveries: unknown[] }) => alert.deliveries);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'EMAIL', recipientId: r.id, recipientLabel: 'Nöbetçi Ayşe' }),
        expect.objectContaining({ channel: 'TELEGRAM', recipientId: null, recipientLabel: null }),
      ]),
    );
    for (const delivery of deliveries) {
      expect(Object.keys(delivery).sort()).toEqual(
        ['attemptCount', 'channel', 'errorCode', 'kind', 'recipientId', 'recipientLabel', 'sentAt', 'sequence', 'status'].sort(),
      );
    }
    const text = JSON.stringify(response.body);
    expect(text.toLowerCase()).not.toContain('health.person@example.test');
    expect(text).not.toContain(r.maskedAddress);
    expect(text).not.toContain(ENV_ADDRESS);
  });
});
