import { OpsAlertChannel, OpsAlertDeliveryStatus, OpsAlertEmailRouting, OpsAlertNoticeKind, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';

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
