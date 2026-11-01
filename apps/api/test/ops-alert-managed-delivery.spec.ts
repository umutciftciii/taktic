import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertEmailRouting,
  OpsAlertNoticeKind,
  OpsAlertSeverity,
  Prisma,
  UserRole,
} from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/modules/auth/auth.types';
import type { NotificationMessage } from '../src/modules/notifications/notification.port';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../src/modules/offers/refund-policy';
import { OpsAlertDeliveryWorker, opsAlertIdempotencyKey } from '../src/modules/ops-alerts/ops-alert-delivery.worker';
import { OpsAlertEvaluator } from '../src/modules/ops-alerts/ops-alert-evaluator.service';
import { OpsAlertRecipientsService, type RecipientView } from '../src/modules/ops-alerts/ops-alert-recipients.service';
import {
  DELIVERY_MAX_ATTEMPTS,
  noticeChannels,
  noticeTargets,
  type NoticeTarget,
} from '../src/modules/ops-alerts/ops-alert.rules';
import { TelegramAlertPort } from '../src/modules/ops-alerts/telegram-alert.port';
import { SystemHealthService } from '../src/modules/system-health/system-health.service';
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';

/**
 * OBS-ALERT-002 — one e-mail row per managed recipient, and a row that is
 * bound to a recipient goes to that recipient's address or nowhere.
 *
 * What these cases hold the engine to: ENV_LEGACY is OBS-ALERT-001 exactly;
 * MANAGED fans each notice out by preference and severity; a recovery goes
 * only to a recipient that was told and still wants it; each recipient
 * retries on its own; a removed, paused or no-longer-interested recipient's
 * row is cancelled without a send; a key that is gone abandons the row; a
 * legacy row is bound only to the recipient whose identity matches the env
 * address; and no row is ever delivered twice or to the env address once it
 * has a recipient.
 */

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const TELEGRAM_TOKEN = `123456789:${'S3cr3tT0k3n'.repeat(4)}`;
const TELEGRAM_CHAT = '-1001234567890';
const OPS_EMAIL = 'ops-alerts@example.test';

// ---------------------------------------------------------------------------
// Targets, without a database
// ---------------------------------------------------------------------------

describe('noticeTargets', () => {
  const telegram = { botToken: 't', chatId: 'c', timeoutMs: 1000 };
  const configs = [
    { email: OPS_EMAIL, telegram },
    { email: OPS_EMAIL, telegram: null },
    { email: null, telegram },
    { email: null, telegram: null },
  ];
  const kinds = [OpsAlertNoticeKind.OPENED, OpsAlertNoticeKind.REMINDER, OpsAlertNoticeKind.RESOLVED];
  const severities = [OpsAlertSeverity.WARNING, OpsAlertSeverity.CRITICAL];
  const recipients = [
    { id: 'r-warn', notifyWarning: true, notifyCritical: false, notifyRecovery: true },
    { id: 'r-crit', notifyWarning: false, notifyCritical: true, notifyRecovery: false },
  ];

  it('ENV_LEGACY is noticeChannels exactly, whatever recipients exist', () => {
    for (const config of configs) {
      for (const kind of kinds) {
        for (const severity of severities) {
          for (const toldTelegram of [false, true]) {
            for (const toldEmail of [false, true]) {
              const told = new Set<OpsAlertChannel>([
                ...(toldTelegram ? [OpsAlertChannel.TELEGRAM] : []),
                ...(toldEmail ? [OpsAlertChannel.EMAIL] : []),
              ]);
              const expected: NoticeTarget[] = noticeChannels(kind, severity, config, told).map((channel) =>
                channel === OpsAlertChannel.TELEGRAM ? { channel: 'TELEGRAM' } : { channel: 'EMAIL', recipientId: null },
              );
              expect(
                noticeTargets(kind, severity, {
                  routing: OpsAlertEmailRouting.ENV_LEGACY,
                  config,
                  recipients,
                  told: { telegram: toldTelegram, legacyEmail: toldEmail, recipientIds: new Set(['r-warn', 'r-crit']) },
                }),
              ).toEqual(expected);
            }
          }
        }
      }
    }
  });

  it('MANAGED picks recipients by severity and recovery by told, and never the env address', () => {
    const ctx = (told: ReadonlySet<string>, toldTelegram = false) => ({
      routing: OpsAlertEmailRouting.MANAGED,
      config: { email: OPS_EMAIL, telegram },
      recipients,
      told: { telegram: toldTelegram, legacyEmail: true, recipientIds: told },
    });
    expect(noticeTargets('OPENED', 'WARNING', ctx(new Set()))).toEqual([{ channel: 'EMAIL', recipientId: 'r-warn' }]);
    expect(noticeTargets('REMINDER', 'CRITICAL', ctx(new Set()))).toEqual([
      { channel: 'TELEGRAM' },
      { channel: 'EMAIL', recipientId: 'r-crit' },
    ]);
    expect(noticeTargets('RESOLVED', 'CRITICAL', ctx(new Set(['r-warn', 'r-crit']), true))).toEqual([
      { channel: 'TELEGRAM' },
      { channel: 'EMAIL', recipientId: 'r-warn' },
    ]);
    expect(noticeTargets('RESOLVED', 'WARNING', ctx(new Set(['r-crit'])))).toEqual([]);
    expect(
      noticeTargets('OPENED', 'CRITICAL', { ...ctx(new Set()), config: { email: OPS_EMAIL, telegram: null }, recipients: [] }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The engine, against the database
// ---------------------------------------------------------------------------

describe('managed alert delivery', () => {
  let ctx: TestContext;
  let actor: AuthUser;
  let telegramSent: string[];

  const evaluator = () => ctx.app.get(OpsAlertEvaluator);
  const worker = () => ctx.app.get(OpsAlertDeliveryWorker);
  const recipients = () => ctx.app.get(OpsAlertRecipientsService);
  const alertMails = () => ctx.notifications.ofTemplate('ops-alert');

  type Prefs = { notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean };
  const WARN: Prefs = { notifyWarning: true, notifyCritical: false, notifyRecovery: false };
  const CRIT: Prefs = { notifyWarning: false, notifyCritical: true, notifyRecovery: false };
  const ALL: Prefs = { notifyWarning: true, notifyCritical: true, notifyRecovery: true };

  const add = (address: string, prefs: Prefs, label = 'Nöbetçi') =>
    recipients().create(actor, { address, label, ...prefs });

  async function current(id: string): Promise<RecipientView> {
    return (await recipients().list()).find((view) => view.id === id)!;
  }

  async function remove(id: string) {
    const view = await current(id);
    await recipients().remove(actor, id, { version: view.version, reason: 'Ayrıldı', confirmLastCritical: true });
  }

  async function pause(id: string) {
    const view = await current(id);
    await recipients().pause(actor, id, { version: view.version, confirmLastCritical: true });
  }

  async function resume(id: string) {
    const view = await current(id);
    await recipients().resume(actor, id, { version: view.version });
  }

  const setRouting = (emailRouting: OpsAlertEmailRouting) =>
    ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting } });

  async function switchOn(...settings: Array<'requestExpirySchedulerEnabled' | 'unviewedOfferRefundSchedulerEnabled'>) {
    const flags = Object.fromEntries(settings.map((setting) => [setting, true]));
    await ctx.prisma.operationsSettings.upsert({
      where: { id: OPERATIONS_SETTINGS_ID },
      create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS, ...flags },
      update: flags,
    });
  }

  async function run(jobKey: string, status: 'SUCCESS' | 'FAILED', at: Date) {
    await ctx.prisma.schedulerRun.create({
      data: {
        jobKey,
        status,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1000),
        errorCode: status === 'FAILED' ? 'PrismaClientKnownRequestError' : null,
        summary: status === 'SUCCESS' ? 'processed=1' : null,
      },
    });
  }

  /** A WARNING alert: one failed run of a job that moves no money. */
  async function warningAlert() {
    await switchOn('requestExpirySchedulerEnabled');
    await run('request-expiry', 'FAILED', ago(30 * MINUTE));
  }

  /** A CRITICAL alert: a failed run of a job that moves money. */
  async function criticalAlert() {
    await switchOn('unviewedOfferRefundSchedulerEnabled');
    await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
  }

  const deliveries = (where: Prisma.OpsAlertDeliveryWhereInput = {}) =>
    ctx.prisma.opsAlertDelivery.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  async function makeDue() {
    await ctx.prisma.opsAlertDelivery.updateMany({
      where: { status: { in: [OpsAlertDeliveryStatus.PENDING, OpsAlertDeliveryStatus.FAILED] } },
      data: { nextAttemptAt: ago(MINUTE) },
    });
  }

  /** Every log line the Nest logger writes during the case. */
  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    }
    return lines;
  }

  const timeout = () => Object.assign(new Error('timeout'), { errorCode: 'TIMEOUT' });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.operationsSettingsChange.deleteMany();
    await ctx.prisma.operationsSettings.deleteMany();
    ctx.notifications.clear();
    telegramSent = [];
    vi.spyOn(ctx.app.get(TelegramAlertPort), 'send').mockImplementation(async (text: string) => {
      telegramSent.push(text);
      return { providerMessageId: `tg-${telegramSent.length}` };
    });
    vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
    vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
    vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', TELEGRAM_CHAT);
    ctx.app.get(SystemHealthService).clearCache();
    const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, name: 'Kök' });
    actor = { id: user.id, email: user.email, phone: user.phone, name: user.name, role: user.role, isActive: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('routing', () => {
    it('ENV_LEGACY ignores managed recipients entirely', async () => {
      await add('one@example.test', ALL);
      await add('two@example.test', ALL);
      await add('three@example.test', ALL);
      await criticalAlert();

      await evaluator().evaluate();

      const rows = await deliveries();
      expect(rows.map((row) => [row.channel, row.recipientId, row.status]).sort()).toEqual([
        ['EMAIL', null, 'SENT'],
        ['TELEGRAM', null, 'SENT'],
      ]);
      expect(alertMails().map((mail) => mail.to)).toEqual([OPS_EMAIL]);
      expect(telegramSent).toHaveLength(1);
    });

    it('MANAGED fans out one row per matching recipient', async () => {
      const logs = captureLogs();
      const warn = await add('warn@example.test', WARN);
      const crit = await add('crit@example.test', CRIT);
      const both = await add('both@example.test', ALL);
      await add('none@example.test', { notifyWarning: false, notifyCritical: false, notifyRecovery: true });
      await setRouting(OpsAlertEmailRouting.MANAGED);

      await warningAlert();
      await evaluator().evaluate();
      const warningRows = await deliveries();
      expect(warningRows.map((row) => [row.channel, row.recipientId]).sort()).toEqual(
        [
          ['EMAIL', warn.id],
          ['EMAIL', both.id],
        ].sort(),
      );
      expect(telegramSent).toHaveLength(0);

      await criticalAlert();
      await evaluator().evaluate();
      const criticalRows = (await deliveries()).filter((row) => !warningRows.some((seen) => seen.id === row.id));
      expect(criticalRows.map((row) => [row.channel, row.recipientId]).sort()).toEqual(
        [
          ['EMAIL', crit.id],
          ['EMAIL', both.id],
          ['TELEGRAM', null],
        ].sort(),
      );
      expect(telegramSent).toHaveLength(1);

      const rows = await deliveries();
      expect(rows.every((row) => row.status === 'SENT' && row.attemptCount === 1)).toBe(true);
      const byKey = new Map(alertMails().map((mail) => [mail.idempotencyKey, mail]));
      expect(byKey.size).toBe(4);
      const address: Record<string, string> = {
        [warn.id]: 'warn@example.test',
        [crit.id]: 'crit@example.test',
        [both.id]: 'both@example.test',
      };
      for (const row of rows.filter((candidate) => candidate.channel === 'EMAIL')) {
        const mail = byKey.get(opsAlertIdempotencyKey(row.id))!;
        expect(mail.to).toBe(address[row.recipientId!]);
        expect(mail.recipientLogPolicy).toBe('hidden');
      }
      expect(alertMails().some((mail) => mail.to === OPS_EMAIL)).toBe(false);
      const text = logs.join('\n');
      for (const value of [...Object.values(address), 'none@example.test', OPS_EMAIL]) expect(text).not.toContain(value);
    });

    it('resolved goes only to told, active recipients with recovery on', async () => {
      const told = await add('told@example.test', { ...WARN, notifyRecovery: true });
      const quiet = await add('quiet@example.test', WARN);
      const paused = await add('paused@example.test', { ...WARN, notifyRecovery: true });
      const neverTold = await add('critical-only@example.test', { ...CRIT, notifyRecovery: true });
      await setRouting(OpsAlertEmailRouting.MANAGED);

      await warningAlert();
      await evaluator().evaluate();
      expect((await deliveries()).map((row) => row.recipientId).sort()).toEqual([told.id, quiet.id, paused.id].sort());

      await pause(paused.id);
      const late = await add('late@example.test', { ...WARN, notifyRecovery: true });
      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();

      const resolved = await deliveries({ kind: OpsAlertNoticeKind.RESOLVED });
      expect(resolved.map((row) => [row.channel, row.recipientId, row.status])).toEqual([['EMAIL', told.id, 'SENT']]);
      expect(resolved.some((row) => [quiet.id, paused.id, neverTold.id, late.id].includes(row.recipientId!))).toBe(false);
      const recovery = alertMails().filter((mail) => mail.data!.noticeKind === 'RESOLVED');
      expect(recovery.map((mail) => mail.to)).toEqual(['told@example.test']);
    });

    it('escalation reaches a critical-only recipient as a reminder', async () => {
      const warn = await add('warn@example.test', WARN);
      const crit = await add('crit@example.test', CRIT);
      await setRouting(OpsAlertEmailRouting.MANAGED);

      await warningAlert();
      await evaluator().evaluate();
      expect((await deliveries()).map((row) => [row.kind, row.recipientId])).toEqual([['OPENED', warn.id]]);

      await run('request-expiry', 'FAILED', ago(20 * MINUTE));
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();

      const reminders = await deliveries({ kind: OpsAlertNoticeKind.REMINDER });
      expect(reminders.map((row) => [row.channel, row.recipientId, row.status]).sort()).toEqual(
        [
          ['EMAIL', crit.id, 'SENT'],
          ['TELEGRAM', null, 'SENT'],
        ].sort(),
      );
      const reminderMails = alertMails().filter((mail) => mail.data!.noticeKind === 'REMINDER');
      expect(reminderMails.map((mail) => [mail.to, mail.data!.severity])).toEqual([['crit@example.test', 'CRITICAL']]);
    });
  });

  describe('recipient-bound delivery', () => {
    it('each recipient retries and abandons on its own', async () => {
      const logs = captureLogs();
      const failing = await add('failing@example.test', WARN);
      const healthy = await add('healthy@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const originalSend = ctx.notifications.send.bind(ctx.notifications);
      vi.spyOn(ctx.notifications, 'send').mockImplementation(async (message: NotificationMessage) => {
        if (message.to === 'failing@example.test') throw timeout();
        return originalSend(message);
      });

      await warningAlert();
      await evaluator().evaluate();
      for (let attempt = 2; attempt <= DELIVERY_MAX_ATTEMPTS + 1; attempt += 1) {
        await makeDue();
        await worker().deliverDue();
      }

      expect(await deliveries({ recipientId: failing.id })).toMatchObject([
        { status: 'ABANDONED', attemptCount: DELIVERY_MAX_ATTEMPTS, errorCode: 'TIMEOUT' },
      ]);
      expect(await deliveries({ recipientId: healthy.id })).toMatchObject([{ status: 'SENT', attemptCount: 1 }]);
      expect(alertMails().map((mail) => mail.to)).toEqual(['healthy@example.test']);
      const text = logs.join('\n');
      expect(text).toContain('TIMEOUT');
      expect(text).not.toContain('failing@example.test');
      expect(text).not.toContain('f***@example.test');
    });

    it("a removed recipient's pending row is cancelled and nothing is sent", async () => {
      const gone = await add('gone@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      expect(await deliveries()).toMatchObject([{ recipientId: gone.id, status: 'PENDING' }]);
      const send = vi.spyOn(ctx.notifications, 'send');

      await remove(gone.id);
      await makeDue();
      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ recipientId: gone.id, status: 'CANCELLED', errorCode: 'RECIPIENT_REMOVED' }]);
      expect(send).not.toHaveBeenCalled();
    });

    it('a retry after deletion cannot decrypt and is cancelled', async () => {
      // Deleted while the first attempt was in flight: that one letter may
      // reach the address; the retry must not.
      const target = await add('target@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const offered: string[] = [];
      vi.spyOn(ctx.notifications, 'send').mockImplementation(async (message: NotificationMessage) => {
        offered.push(message.to);
        await remove(target.id);
        throw timeout();
      });

      await warningAlert();
      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([{ recipientId: target.id, status: 'FAILED', errorCode: 'TIMEOUT', attemptCount: 1 }]);
      const shredded = await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: target.id } });
      expect(shredded).toMatchObject({ status: 'DELETED', addressCiphertext: null, addressKeyId: null });

      await makeDue();
      const pass = await worker().deliverDue();

      expect(pass).toMatchObject({ claimed: 1, sent: 0, cancelled: 1 });
      expect(await deliveries()).toMatchObject([
        { recipientId: target.id, status: 'CANCELLED', errorCode: 'RECIPIENT_REMOVED', attemptCount: 2, claimToken: null },
      ]);
      expect(offered).toEqual(['target@example.test']);
    });

    it('a retry after deletion between attempts is cancelled and the port sees one call', async () => {
      const target = await add('target@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const send = vi.spyOn(ctx.notifications, 'send').mockRejectedValueOnce(timeout());

      await warningAlert();
      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([{ status: 'FAILED', errorCode: 'TIMEOUT' }]);
      await remove(target.id);
      await makeDue();
      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ status: 'CANCELLED', errorCode: 'RECIPIENT_REMOVED' }]);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("a paused recipient's row is cancelled; resuming does not revive it", async () => {
      const resting = await add('resting@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      const send = vi.spyOn(ctx.notifications, 'send');

      await pause(resting.id);
      await worker().deliverDue();
      expect(await deliveries()).toMatchObject([{ status: 'CANCELLED', errorCode: 'RECIPIENT_PAUSED', attemptCount: 1 }]);

      await resume(resting.id);
      await makeDue();
      expect(await worker().deliverDue()).toMatchObject({ claimed: 0 });
      expect(await deliveries()).toMatchObject([{ status: 'CANCELLED', errorCode: 'RECIPIENT_PAUSED' }]);
      expect(send).not.toHaveBeenCalled();
    });

    it('a preference switched off after queueing cancels the row', async () => {
      const changing = await add('changing@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      const send = vi.spyOn(ctx.notifications, 'send');

      await recipients().update(actor, changing.id, { version: changing.version, notifyWarning: false });
      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ status: 'CANCELLED', errorCode: 'PREFERENCE_OFF' }]);
      expect(send).not.toHaveBeenCalled();
    });

    it('a key removed from the keyring abandons with DECRYPT_FAILED and sends nowhere', async () => {
      const sealed = await add('sealed@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      const send = vi.spyOn(ctx.notifications, 'send');

      // The keyring now holds only v2; the recipient was sealed under v1.
      vi.stubEnv('OPS_ALERT_RECIPIENT_ENC_KEYS', `v2:${randomBytes(32).toString('base64')}`);
      vi.stubEnv('OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE', 'v2');
      const pass = await worker().deliverDue();

      expect(pass).toMatchObject({ claimed: 1, abandoned: 1 });
      expect(await deliveries()).toMatchObject([
        { recipientId: sealed.id, status: 'ABANDONED', errorCode: 'DECRYPT_FAILED', attemptCount: 1 },
      ]);
      expect(send).not.toHaveBeenCalled();
      await makeDue();
      expect(await worker().deliverDue()).toMatchObject({ claimed: 0 });
    });

    it('a row bound to a recipient never falls back to the env address, even after routing goes back', async () => {
      const bound = await add('bound@example.test', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      await setRouting(OpsAlertEmailRouting.ENV_LEGACY);

      await worker().deliverDue();

      // ENV_LEGACY e-mails only the env address: the bound row stops, and goes nowhere else.
      expect(await deliveries()).toMatchObject([{ recipientId: bound.id, status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' }]);
      expect(alertMails()).toEqual([]);
    });

    it("in ENV_LEGACY, the env address's own row with no legacy row is un-bound and sent the legacy way, paused or not", async () => {
      // Left bound by hand (or across an env address change): the mailbox's only copy.
      const own = await add(OPS_EMAIL, WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      await setRouting(OpsAlertEmailRouting.ENV_LEGACY);
      // ENV_LEGACY does not read the recipient's pause or preferences, as it does not for OPS_ALERT_EMAIL.
      await pause(own.id);
      await ctx.prisma.opsAlertRecipient.update({ where: { id: own.id }, data: { notifyWarning: false } });

      await worker().deliverDue();

      const [row] = await deliveries({ channel: OpsAlertChannel.EMAIL });
      expect(row).toMatchObject({ recipientId: null, status: 'SENT' });
      expect(alertMails().map((mail) => [mail.to, mail.idempotencyKey])).toEqual([[OPS_EMAIL, opsAlertIdempotencyKey(row!.id)]]);

      // Told as the env address: the RESOLVED goes there.
      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();
      expect(await deliveries({ kind: 'RESOLVED', channel: OpsAlertChannel.EMAIL })).toMatchObject([
        { recipientId: null, status: 'SENT' },
      ]);
      expect(alertMails().filter((mail) => mail.data!.noticeKind === 'RESOLVED').map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it("in ENV_LEGACY, the env address's own row beside only a dead legacy row goes to it, still bound", async () => {
      const own = await add(OPS_EMAIL, WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      const [row] = await deliveries({ channel: OpsAlertChannel.EMAIL });
      await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: row!.alertId,
          kind: row!.kind,
          sequence: row!.sequence,
          channel: OpsAlertChannel.EMAIL,
          status: OpsAlertDeliveryStatus.CANCELLED,
          errorCode: 'LEGACY_AFTER_CUTOVER',
          nextAttemptAt: new Date(),
        },
      });
      await setRouting(OpsAlertEmailRouting.ENV_LEGACY);
      await pause(own.id);

      await worker().deliverDue();

      expect(await deliveries({ id: row!.id })).toMatchObject([{ recipientId: own.id, status: 'SENT' }]);
      expect(alertMails().map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it("in ENV_LEGACY, the env address's own row beside a live legacy row is cancelled", async () => {
      const own = await add(OPS_EMAIL, WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      const [row] = await deliveries({ channel: OpsAlertChannel.EMAIL });
      const legacy = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: row!.alertId,
          kind: row!.kind,
          sequence: row!.sequence,
          channel: OpsAlertChannel.EMAIL,
          status: OpsAlertDeliveryStatus.SENT,
          sentAt: new Date(),
          nextAttemptAt: new Date(),
        },
      });
      await setRouting(OpsAlertEmailRouting.ENV_LEGACY);

      await worker().deliverDue();

      expect(await deliveries({ id: row!.id })).toMatchObject([
        { recipientId: own.id, status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' },
      ]);
      expect(await deliveries({ id: legacy.id })).toMatchObject([{ status: 'SENT' }]);
      expect(alertMails()).toEqual([]);
    });

    it('two workers never deliver the same recipient row twice', async () => {
      for (const name of ['a', 'b', 'c', 'd']) await add(`${name}@example.test`, WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await warningAlert();
      await evaluator().evaluateOnly();
      expect(await deliveries({ status: 'PENDING' })).toHaveLength(4);

      const passes = await Promise.all(Array.from({ length: 6 }, () => worker().deliverDue()));

      expect(passes.reduce((sum, pass) => sum + pass.claimed, 0)).toBe(4);
      const rows = await deliveries();
      expect(rows.every((row) => row.status === 'SENT' && row.attemptCount === 1)).toBe(true);
      const mails = alertMails();
      expect(mails).toHaveLength(4);
      expect(new Set(mails.map((mail) => mail.to)).size).toBe(4);
      expect(new Set(mails.map((mail) => mail.idempotencyKey))).toEqual(new Set(rows.map((row) => opsAlertIdempotencyKey(row.id))));
    });
  });

  describe('legacy rows after the cutover', () => {
    it('a legacy row in MANAGED binds to the recipient whose hmac matches the env address', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries();
      expect(legacy).toMatchObject({ channel: 'EMAIL', recipientId: null, status: 'PENDING' });

      await add('someone-else@example.test', WARN);
      const imported = await add('  OPS-Alerts@Example.TEST ', WARN);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ id: legacy!.id, recipientId: imported.id, status: 'SENT', claimToken: null }]);
      const mails = alertMails();
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({
        to: OPS_EMAIL,
        idempotencyKey: opsAlertIdempotencyKey(legacy!.id),
        recipientLogPolicy: 'hidden',
      });
    });

    it('a legacy row in MANAGED is cancelled when none matches', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      await add('someone-else@example.test', ALL);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const send = vi.spyOn(ctx.notifications, 'send');

      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ recipientId: null, status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);
      expect(send).not.toHaveBeenCalled();
    });

    it('a legacy row in MANAGED is not bound to a paused recipient with the env address', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const resting = await add(OPS_EMAIL, WARN);
      await pause(resting.id);
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const send = vi.spyOn(ctx.notifications, 'send');

      await worker().deliverDue();

      expect(await deliveries()).toMatchObject([{ recipientId: null, status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);
      expect(send).not.toHaveBeenCalled();
    });

    it('a legacy row is cancelled, not bound, when the recipient already has a row for that notice', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries();
      const imported = await add(OPS_EMAIL, WARN);
      await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacy!.alertId,
          kind: legacy!.kind,
          sequence: legacy!.sequence,
          channel: OpsAlertChannel.EMAIL,
          recipientId: imported.id,
          status: OpsAlertDeliveryStatus.SENT,
          nextAttemptAt: new Date(),
          sentAt: new Date(),
        },
      });
      await setRouting(OpsAlertEmailRouting.MANAGED);
      const send = vi.spyOn(ctx.notifications, 'send');

      await worker().deliverDue();

      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: null, status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' },
      ]);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
