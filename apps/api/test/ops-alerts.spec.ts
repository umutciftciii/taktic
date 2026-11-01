import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  AdminPermission,
  NotificationChannel,
  NotificationStatus,
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertNoticeKind,
  OpsAlertSeverity,
  OpsAlertSource,
  Prisma,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../src/modules/offers/refund-policy';
import {
  OpsAlertConfigError,
  assertOpsAlertConfig,
  opsAlertChannelStatus,
  readOpsAlertConfig,
} from '../src/modules/ops-alerts/ops-alert.config';
import { OpsAlertDeliveryWorker, opsAlertIdempotencyKey } from '../src/modules/ops-alerts/ops-alert-delivery.worker';
import { OpsAlertEvaluator } from '../src/modules/ops-alerts/ops-alert-evaluator.service';
import {
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  EMAIL_RECOVERY_QUIET_MS,
  OPS_ALERT_ENGINE_STATE_ID,
  REMINDER_INTERVAL_MS,
  composeNotice,
  deliveryBackoffMs,
  emailRecovered,
  emailSeverity,
  evaluateEngine,
  isAlertableEmailCode,
  newAlertRef,
  noticeChannels,
  readNoticeSnapshot,
  reminderDue,
  schedulerDecision,
  snapshotNotice,
  systemHealthUrl,
  type SchedulerJobObservation,
} from '../src/modules/ops-alerts/ops-alert.rules';
import { TelegramAlertPort, TelegramBotApiAdapter, TelegramSendError } from '../src/modules/ops-alerts/telegram-alert.port';
import { SystemHealthService } from '../src/modules/system-health/system-health.service';
import { createAdminWithPermissions, createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * OBS-ALERT-001 — operations alerts to Telegram and e-mail.
 *
 * What these cases hold the engine to: an alert opens once per problem and
 * then stays quiet (debounce), a different problem is a new alert, recovery
 * is told once and only where the problem was told, each channel retries on
 * its own, a delivery is held by one worker at a time, restarts and parallel
 * evaluators change nothing, the engine's own trouble never feeds back into
 * what it watches, and nothing personal or secret leaves in a message or in
 * the health report.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms);

const TELEGRAM_TOKEN = `123456789:${'S3cr3tT0k3n'.repeat(4)}`;
const TELEGRAM_CHAT = '-1001234567890';
const OPS_EMAIL = 'ops-alerts@example.test';

// ---------------------------------------------------------------------------
// Rules, without a database
// ---------------------------------------------------------------------------

function job(overrides: Partial<SchedulerJobObservation>): SchedulerJobObservation {
  return {
    key: 'request-expiry',
    enabled: true,
    status: 'HEALTHY',
    reason: 'LAST_RUN_SUCCEEDED',
    missedTicks: 0,
    lastRun: { status: 'SUCCESS', startedAt: ago(MINUTE).toISOString(), finishedAt: ago(MINUTE).toISOString(), errorType: null },
    ...overrides,
  };
}

describe('rules', () => {
  const now = new Date();

  it('never alerts for a switched-off job, and closes what it had as DISABLED', () => {
    expect(schedulerDecision(job({ enabled: false, status: 'UNKNOWN', reason: 'DISABLED' }), now)).toEqual({
      kind: 'RESOLVE',
      resolution: 'DISABLED',
    });
  });

  it('does not judge a job before its first tick, and an open run only ends lateness', () => {
    expect(schedulerDecision(job({ status: 'UNKNOWN', reason: 'NO_RECORDED_RUN', lastRun: null }), now)).toEqual({
      kind: 'NEUTRAL',
      resolveOverdue: false,
    });
    expect(schedulerDecision(job({ reason: 'RUNNING' }), now)).toEqual({ kind: 'NEUTRAL', resolveOverdue: true });
  });

  it('reads failures by error type, CRITICAL when the job moves money or failed three times', () => {
    const failed = (key: SchedulerJobObservation['key'], status: 'DEGRADED' | 'DOWN') =>
      schedulerDecision(
        job({
          key,
          status,
          reason: status === 'DOWN' ? 'REPEATED_FAILURES' : 'LAST_RUN_FAILED',
          lastRun: { status: 'FAILED', startedAt: ago(MINUTE).toISOString(), finishedAt: null, errorType: 'DATABASE_ERROR' },
        }),
        now,
      );
    expect(failed('request-expiry', 'DEGRADED')).toMatchObject({ kind: 'PROBLEM', condition: 'DATABASE_ERROR', severity: 'WARNING' });
    expect(failed('request-expiry', 'DOWN')).toMatchObject({ severity: 'CRITICAL' });
    expect(failed('unviewed-offer-refund', 'DEGRADED')).toMatchObject({ severity: 'CRITICAL' });
    expect(failed('entitlement-renewal', 'DEGRADED')).toMatchObject({ severity: 'CRITICAL' });
  });

  it('reads a late job as OVERDUE, CRITICAL at three missed ticks', () => {
    expect(schedulerDecision(job({ status: 'DEGRADED', reason: 'OVERDUE', missedTicks: 1 }), now)).toMatchObject({
      kind: 'PROBLEM',
      condition: 'OVERDUE',
      severity: 'WARNING',
    });
    expect(schedulerDecision(job({ status: 'DOWN', reason: 'OVERDUE', missedTicks: 3 }), now)).toMatchObject({
      severity: 'CRITICAL',
    });
  });

  it('routes notices: e-mail always, Telegram for CRITICAL, recovery only where it was told', () => {
    const both = { email: OPS_EMAIL, telegram: { botToken: 't', chatId: 'c', timeoutMs: 1000 } };
    const none = new Set<OpsAlertChannel>();
    expect(noticeChannels('OPENED', 'WARNING', both, none)).toEqual(['EMAIL']);
    expect(noticeChannels('OPENED', 'CRITICAL', both, none)).toEqual(['TELEGRAM', 'EMAIL']);
    expect(noticeChannels('REMINDER', 'CRITICAL', { email: null, telegram: both.telegram }, none)).toEqual(['TELEGRAM']);
    expect(noticeChannels('RESOLVED', 'WARNING', both, new Set(['EMAIL']))).toEqual(['EMAIL']);
    expect(noticeChannels('RESOLVED', 'CRITICAL', both, new Set(['TELEGRAM', 'EMAIL']))).toEqual(['TELEGRAM', 'EMAIL']);
    expect(noticeChannels('RESOLVED', 'CRITICAL', both, none)).toEqual([]);
    expect(noticeChannels('OPENED', 'CRITICAL', { email: null, telegram: null }, none)).toEqual([]);
  });

  it('reminds only after the interval and only about a problem seen again', () => {
    const notified = ago(REMINDER_INTERVAL_MS + MINUTE);
    expect(reminderDue({ lastNotifiedAt: notified, lastSeenAt: new Date() }, now)).toBe(true);
    expect(reminderDue({ lastNotifiedAt: notified, lastSeenAt: ago(REMINDER_INTERVAL_MS + 2 * MINUTE) }, now)).toBe(false);
    expect(reminderDue({ lastNotifiedAt: ago(HOUR), lastSeenAt: new Date() }, now)).toBe(false);
  });

  it('treats e-mail as recovered only after 30 quiet minutes and with a sent message as evidence', () => {
    expect(emailRecovered(ago(EMAIL_RECOVERY_QUIET_MS + MINUTE), now, true)).toBe(true);
    expect(emailRecovered(ago(EMAIL_RECOVERY_QUIET_MS + MINUTE), now, false)).toBe(false);
    expect(emailRecovered(ago(EMAIL_RECOVERY_QUIET_MS - MINUTE), now, true)).toBe(false);
  });

  it('ignores recipient-level e-mail failures; transport and configuration are CRITICAL at once', () => {
    expect(isAlertableEmailCode('INVALID_RECIPIENT')).toBe(false);
    expect(isAlertableEmailCode('RECIPIENT_RELEASED')).toBe(false);
    expect(isAlertableEmailCode('TIMEOUT')).toBe(true);
    expect(emailSeverity('TRANSPORT_UNAVAILABLE', 1)).toBe('CRITICAL');
    expect(emailSeverity('EMAIL_BRANDING_INCOMPLETE', 1)).toBe('CRITICAL');
    expect(emailSeverity('TIMEOUT', 1)).toBe('WARNING');
    expect(emailSeverity('TIMEOUT', 3)).toBe('CRITICAL');
  });

  it('backs off and bounds attempts', () => {
    expect(deliveryBackoffMs(1)).toBe(5 * MINUTE);
    expect(deliveryBackoffMs(4)).toBe(HOUR);
    expect(deliveryBackoffMs(99)).toBe(HOUR);
    expect(DELIVERY_MAX_ATTEMPTS).toBe(5);
  });

  it('judges the engine itself by its own missed ticks', () => {
    const cron = '*/5 * * * *';
    const booted = ago(2 * MINUTE);
    expect(evaluateEngine(null, cron, now, booted)).toMatchObject({ status: 'UNKNOWN', reason: 'NEVER_RAN' });
    expect(evaluateEngine(null, cron, now, ago(HOUR))).toMatchObject({ status: 'DOWN', reason: 'OVERDUE' });
    expect(evaluateEngine({ lastSucceededAt: ago(MINUTE), lastFailedAt: null }, cron, now, booted)).toMatchObject({
      status: 'HEALTHY',
    });
    expect(evaluateEngine({ lastSucceededAt: ago(12 * MINUTE), lastFailedAt: null }, cron, now, booted)).toMatchObject({
      status: 'DEGRADED',
      reason: 'OVERDUE',
    });
    expect(evaluateEngine({ lastSucceededAt: ago(MINUTE), lastFailedAt: new Date() }, cron, now, booted)).toMatchObject({
      status: 'DEGRADED',
      reason: 'LAST_EVALUATION_FAILED',
    });
  });

  it('gives every alert a fixed, meaningless event id', () => {
    const refs = new Set(Array.from({ length: 200 }, () => newAlertRef()));
    expect(refs.size).toBe(200);
    for (const ref of refs) expect(ref).toMatch(/^OPS-[A-Z2-9]{10}$/);
  });

  it('composes both channels from safe fields only, with one parameterless panel link', () => {
    expect(systemHealthUrl('https://panel.example.test/')).toBe('https://panel.example.test/system-health');
    expect(systemHealthUrl('https://user:pw@panel.example.test')).toBeNull();
    expect(systemHealthUrl('javascript:alert(1)')).toBeNull();

    const notice = composeNotice(
      'OPENED',
      {
        ref: 'OPS-ABCDEFGH23',
        source: 'EMAIL',
        subjectKey: 'TRANSPORT_UNAVAILABLE',
        condition: 'SEND_FAILURES',
        severity: 'CRITICAL',
        firstSeenAt: ago(HOUR),
        lastSeenAt: new Date(),
        occurrenceCount: 4,
        resolvedAt: null,
        resolution: null,
        detail: { templates: ['offer-received', 'password-reset'], recipient: 'leak@example.test' },
      },
      'https://panel.example.test/system-health',
    );
    expect(notice.telegramText).toContain('OPS-ABCDEFGH23');
    expect(notice.telegramText).toContain('🔴 KRİTİK');
    expect(notice.telegramText).toContain('Şablonlar: offer-received, password-reset');
    expect(notice.telegramText).toContain('https://panel.example.test/system-health');
    expect(notice.emailData).toMatchObject({ alertRef: 'OPS-ABCDEFGH23', occurrenceCount: '4' });
    expect(JSON.stringify(notice)).not.toContain('leak@example.test');
  });
});

describe('configuration', () => {
  const env = (values: Record<string, string>) => ({ ...values }) as NodeJS.ProcessEnv;

  it('takes either channel, both, or neither', () => {
    expect(readOpsAlertConfig(env({}))).toEqual({ email: null, telegram: null });
    expect(readOpsAlertConfig(env({ OPS_ALERT_EMAIL: ' Ops@Example.TEST ' })).email).toBe('ops@example.test');
    expect(
      readOpsAlertConfig(env({ OPS_ALERT_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, OPS_ALERT_TELEGRAM_CHAT_ID: TELEGRAM_CHAT })).telegram,
    ).toEqual({ botToken: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT, timeoutMs: 10_000 });
  });

  it.each([
    [{ OPS_ALERT_EMAIL: 'not-an-address' }, 'OPS_ALERT_EMAIL'],
    [{ OPS_ALERT_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN }, 'set together'],
    [{ OPS_ALERT_TELEGRAM_CHAT_ID: TELEGRAM_CHAT }, 'set together'],
    [{ OPS_ALERT_TELEGRAM_BOT_TOKEN: 'wrong-variable-not-real', OPS_ALERT_TELEGRAM_CHAT_ID: TELEGRAM_CHAT }, 'not a Telegram bot token'],
    [{ OPS_ALERT_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, OPS_ALERT_TELEGRAM_CHAT_ID: 'https://t.me/x' }, 'not a Telegram chat id'],
    [{ OPS_ALERT_EMAIL: OPS_EMAIL, OPS_ALERT_TELEGRAM_TIMEOUT_MS: 'soon' }, 'OPS_ALERT_TELEGRAM_TIMEOUT_MS'],
  ])('refuses %j at boot, naming the variable and never the value', (values, message) => {
    let thrown: unknown;
    try {
      assertOpsAlertConfig(env({ APP_ENVIRONMENT: 'staging', ...values }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpsAlertConfigError);
    const text = String((thrown as Error).message);
    expect(text).toContain(message);
    for (const value of Object.values(values)) expect(text).not.toContain(value);
  });

  it('requires a channel in production, warns on staging, and is quiet locally', () => {
    expect(() => assertOpsAlertConfig(env({ APP_ENVIRONMENT: 'production' }))).toThrow(/requires an operations alert channel/);
    expect(() => assertOpsAlertConfig(env({ APP_ENVIRONMENT: 'production', OPS_ALERT_EMAIL: OPS_EMAIL }))).not.toThrow();
    expect(() =>
      assertOpsAlertConfig(
        env({ APP_ENVIRONMENT: 'production', OPS_ALERT_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN, OPS_ALERT_TELEGRAM_CHAT_ID: TELEGRAM_CHAT }),
      ),
    ).not.toThrow();

    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(() => assertOpsAlertConfig(env({ APP_ENVIRONMENT: 'staging' }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => assertOpsAlertConfig(env({ APP_ENVIRONMENT: 'local' }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('says which channels exist, never what they are', () => {
    expect(opsAlertChannelStatus(env({ OPS_ALERT_EMAIL: OPS_EMAIL }))).toEqual({ email: true, telegram: false });
    expect(opsAlertChannelStatus(env({ OPS_ALERT_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN }))).toEqual({ email: false, telegram: false });
  });
});

// ---------------------------------------------------------------------------
// The Telegram adapter, against a local stand-in for the Bot API
// ---------------------------------------------------------------------------

describe('Telegram adapter', () => {
  type Stub = { server: Server; origin: string; requests: Array<{ path: string; body: string }>; respond: (req: IncomingMessage, res: ServerResponse) => void };
  let stub: Stub;

  beforeAll(async () => {
    const requests: Stub['requests'] = [];
    const holder = {} as Stub;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ path: req.url ?? '', body });
        holder.respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    Object.assign(holder, { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests });
    stub = holder;
  });

  beforeEach(() => {
    stub.requests.length = 0;
    vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
    vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', TELEGRAM_CHAT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
  });

  it('sends one plain-text sendMessage to the configured chat and reads back only the id', async () => {
    stub.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 1, title: 'ops' } } }));
    };
    const result = await new TelegramBotApiAdapter(stub.origin).send('hello');
    expect(result).toEqual({ providerMessageId: '77' });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.path).toBe(`/bot${TELEGRAM_TOKEN}/sendMessage`);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ chat_id: TELEGRAM_CHAT, text: 'hello', disable_web_page_preview: true });
  });

  it('reduces a refusal and a timeout to a closed code, and never writes the token anywhere', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(String(message));
      });
    }

    stub.respond = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: `Unauthorized ${TELEGRAM_TOKEN}` }));
    };
    const refused = await new TelegramBotApiAdapter(stub.origin).send('x').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TelegramSendError);
    expect((refused as TelegramSendError).code).toBe('REJECTED');

    stub.respond = (_req, res) => {
      res.writeHead(500);
      res.end();
    };
    const down = await new TelegramBotApiAdapter(stub.origin).send('x').catch((error: unknown) => error);
    expect((down as TelegramSendError).code).toBe('TRANSPORT_UNAVAILABLE');

    vi.stubEnv('OPS_ALERT_TELEGRAM_TIMEOUT_MS', '1000');
    stub.respond = () => undefined; // never answers
    const late = await new TelegramBotApiAdapter(stub.origin).send('x').catch((error: unknown) => error);
    expect((late as TelegramSendError).code).toBe('TIMEOUT');

    const unreachable = await new TelegramBotApiAdapter('http://127.0.0.1:1').send('x').catch((error: unknown) => error);
    expect((unreachable as TelegramSendError).code).toBe('TRANSPORT_UNAVAILABLE');

    const everything = [logs.join('\n'), ...[refused, down, late, unreachable].map((error) => `${(error as Error).message} ${(error as Error).stack}`)].join('\n');
    expect(everything).not.toContain(TELEGRAM_TOKEN);
    expect(everything).not.toContain('S3cr3t');
    expect(everything).not.toContain(TELEGRAM_CHAT);
  });

  it('refuses to send without a configured channel', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', '');
    const error = await new TelegramBotApiAdapter(stub.origin).send('x').catch((thrown: unknown) => thrown);
    expect((error as TelegramSendError).code).toBe('NOT_CONFIGURED');
    expect(stub.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The engine, against the database
// ---------------------------------------------------------------------------

describe('the alert engine', () => {
  let ctx: TestContext;
  let telegramSent: string[];
  let telegramFails: Array<() => Error>;

  const evaluator = () => ctx.app.get(OpsAlertEvaluator);
  const worker = () => ctx.app.get(OpsAlertDeliveryWorker);
  const alertMails = () => ctx.notifications.ofTemplate('ops-alert');

  function wireTelegram(app: TestContext['app']) {
    vi.spyOn(app.get(TelegramAlertPort), 'send').mockImplementation(async (text: string) => {
      const failure = telegramFails.shift();
      if (failure) throw failure();
      telegramSent.push(text);
      return { providerMessageId: `tg-${telegramSent.length}` };
    });
  }

  function bothChannels() {
    vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
    vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
    vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', TELEGRAM_CHAT);
  }

  async function switchOn(...settings: Array<'requestExpirySchedulerEnabled' | 'requestReminderSchedulerEnabled' | 'unviewedOfferRefundSchedulerEnabled'>) {
    const flags = Object.fromEntries(settings.map((setting) => [setting, true]));
    await ctx.prisma.operationsSettings.upsert({
      where: { id: OPERATIONS_SETTINGS_ID },
      create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS, ...flags },
      update: flags,
    });
  }

  async function switchOff(setting: 'requestExpirySchedulerEnabled') {
    await ctx.prisma.operationsSettings.update({ where: { id: OPERATIONS_SETTINGS_ID }, data: { [setting]: false } });
  }

  async function run(jobKey: string, status: 'SUCCESS' | 'FAILED', at: Date, errorCode = 'PrismaClientKnownRequestError') {
    await ctx.prisma.schedulerRun.create({
      data: {
        jobKey,
        status,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1000),
        errorCode: status === 'FAILED' ? errorCode : null,
        summary: status === 'SUCCESS' ? 'processed=1' : null,
      },
    });
  }

  async function failedEmail(errorCode: string, at: Date, template = 'offer-received') {
    await ctx.prisma.notificationLog.create({
      data: {
        channel: NotificationChannel.EMAIL,
        template,
        maskedRecipient: 'c***@example.test',
        status: NotificationStatus.FAILED,
        errorCode,
        createdAt: at,
        lastAttemptAt: at,
        failedAt: at,
      },
    });
  }

  async function sentEmail(at: Date) {
    await ctx.prisma.notificationLog.create({
      data: {
        channel: NotificationChannel.EMAIL,
        template: 'offer-received',
        maskedRecipient: 'c***@example.test',
        status: NotificationStatus.SENT,
        createdAt: at,
        lastAttemptAt: at,
        sentAt: at,
      },
    });
  }

  const alerts = () => ctx.prisma.opsAlert.findMany({ orderBy: { createdAt: 'asc' } });
  /** In creation order, and e-mail before Telegram within one notice. */
  const deliveries = async (where: Prisma.OpsAlertDeliveryWhereInput = {}) =>
    (await ctx.prisma.opsAlertDelivery.findMany({ where })).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.channel.localeCompare(b.channel),
    );

  /** Moves an alert's last notice into the past, as if hours had gone by. */
  async function ageNotice(id: string, by: number) {
    await ctx.prisma.opsAlert.update({ where: { id }, data: { lastNotifiedAt: ago(by) } });
  }

  /** Makes every waiting delivery due now. */
  async function makeDue() {
    await ctx.prisma.opsAlertDelivery.updateMany({
      where: { status: { in: [OpsAlertDeliveryStatus.PENDING, OpsAlertDeliveryStatus.FAILED] } },
      data: { nextAttemptAt: ago(MINUTE) },
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.operationsSettingsChange.deleteMany();
    await ctx.prisma.operationsSettings.deleteMany();
    ctx.notifications.clear();
    telegramSent = [];
    telegramFails = [];
    wireTelegram(ctx.app);
    bothChannels();
    ctx.app.get(SystemHealthService).clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('scheduled jobs', () => {
    it('opens one alert on a first failure and tells e-mail only, for a job that moves no money', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(2 * MINUTE));

      expect(await evaluator().evaluate()).toBe('EVALUATED');

      const [alert, ...rest] = await alerts();
      expect(rest).toHaveLength(0);
      expect(alert).toMatchObject({
        source: 'SCHEDULER',
        subjectKey: 'request-expiry',
        condition: 'DATABASE_ERROR',
        severity: 'WARNING',
        state: 'OPEN',
        occurrenceCount: 1,
      });
      expect(alert!.ref).toMatch(/^OPS-/);
      expect(await deliveries()).toMatchObject([{ kind: 'OPENED', channel: 'EMAIL', status: 'SENT', attemptCount: 1 }]);
      expect(telegramSent).toHaveLength(0);

      const [mail] = alertMails();
      expect(mail).toMatchObject({ to: OPS_EMAIL, template: 'ops-alert' });
      expect(mail!.subject).toContain(alert!.ref);
      expect(mail!.data).toMatchObject({ noticeKind: 'OPENED', subjectLabel: 'Talep süresi dolumu', conditionLabel: 'Veritabanı hatası' });
      expect(mail!.data!.adminUrl).toMatch(/\/system-health$/);
      const delivery = (await deliveries())[0]!;
      expect(mail!.idempotencyKey).toBe(opsAlertIdempotencyKey(delivery.id));
      // The alert's own send is not a NotificationLog row: it can never be read back as an e-mail failure.
      expect(await ctx.prisma.notificationLog.count()).toBe(0);
    });

    it('sends a money-moving job straight to Telegram as well', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(2 * MINUTE), 'TypeError');

      await evaluator().evaluate();

      expect(await alerts()).toMatchObject([{ condition: 'APPLICATION_ERROR', severity: 'CRITICAL' }]);
      expect((await deliveries()).map((row) => [row.channel, row.status])).toEqual([
        ['EMAIL', 'SENT'],
        ['TELEGRAM', 'SENT'],
      ]);
      expect(telegramSent).toHaveLength(1);
      expect(telegramSent[0]).toContain('🔴 KRİTİK');
      expect(telegramSent[0]).toContain('Görüntülenmeyen teklif iadesi');
    });

    it('stays quiet about the same failure, counts the repeats, and reminds only after six hours', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(30 * MINUTE));
      await evaluator().evaluate();
      await evaluator().evaluate();
      await evaluator().evaluate();

      let [alert] = await alerts();
      expect(alert!.occurrenceCount).toBe(1);
      expect(alertMails()).toHaveLength(1);

      // A second failure of the same kind: counted, still no message.
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();
      [alert] = await alerts();
      expect(alert!.occurrenceCount).toBe(2);
      expect(alertMails()).toHaveLength(1);

      // Six hours on, still failing: one REMINDER.
      await ageNotice(alert!.id, REMINDER_INTERVAL_MS + MINUTE);
      await run('request-expiry', 'FAILED', ago(MINUTE / 2), 'PrismaClientUnknownRequestError');
      await evaluator().evaluate();
      [alert] = await alerts();
      // Three failures in a row is DOWN on the health screen: the reminder also escalates.
      expect(alert).toMatchObject({ occurrenceCount: 3, reminderCount: 1, severity: 'CRITICAL' });
      expect(alertMails().map((mail) => mail.data!.noticeKind)).toEqual(['OPENED', 'REMINDER']);
      expect(await deliveries({ kind: 'REMINDER' })).toMatchObject([
        { sequence: 1, channel: 'EMAIL', status: 'SENT' },
        { sequence: 1, channel: 'TELEGRAM', status: 'SENT' },
      ]);

      // A tick later nothing new is said.
      await evaluator().evaluate();
      expect(alertMails()).toHaveLength(2);
      expect(telegramSent).toHaveLength(1);
    });

    it('escalates at once when the third failure in a row makes the job DOWN', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(30 * MINUTE));
      await evaluator().evaluate();
      expect(telegramSent).toHaveLength(0);

      await run('request-expiry', 'FAILED', ago(20 * MINUTE));
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();

      expect(await alerts()).toMatchObject([{ severity: 'CRITICAL', reminderCount: 1 }]);
      expect(telegramSent).toHaveLength(1);
      expect(telegramSent[0]).toContain('Sorun sürüyor');
    });

    it('opens a new alert for a different error and closes the old one without a recovery notice', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(20 * MINUTE));
      await evaluator().evaluate();
      await run('request-expiry', 'FAILED', ago(5 * MINUTE), 'TypeError');
      await evaluator().evaluate();

      const [first, second] = await alerts();
      expect(first).toMatchObject({ condition: 'DATABASE_ERROR', state: 'RESOLVED', resolution: 'SUPERSEDED' });
      expect(second).toMatchObject({ condition: 'APPLICATION_ERROR', state: 'OPEN' });
      expect(second!.ref).not.toBe(first!.ref);
      expect(alertMails().map((mail) => [mail.data!.noticeKind, mail.data!.alertRef])).toEqual([
        ['OPENED', first!.ref],
        ['OPENED', second!.ref],
      ]);
    });

    it('tells the recovery once, on the channels that heard about the problem', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled', 'requestExpirySchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(30 * MINUTE));
      await run('request-expiry', 'FAILED', ago(30 * MINUTE));
      await evaluator().evaluate();
      expect(telegramSent).toHaveLength(1);

      await run('unviewed-offer-refund', 'SUCCESS', ago(5 * MINUTE));
      await run('request-expiry', 'SUCCESS', ago(5 * MINUTE));
      await evaluator().evaluate();
      await evaluator().evaluate();

      expect((await alerts()).map((alert) => [alert.subjectKey, alert.state, alert.resolution])).toEqual(
        expect.arrayContaining([
          ['unviewed-offer-refund', 'RESOLVED', 'RECOVERED'],
          ['request-expiry', 'RESOLVED', 'RECOVERED'],
        ]),
      );
      const resolved = await deliveries({ kind: 'RESOLVED' });
      // The money job's recovery reaches both; the WARNING job never reached Telegram, so neither does its recovery.
      expect(resolved).toHaveLength(3);
      expect(telegramSent).toHaveLength(2);
      expect(telegramSent[1]).toContain('Düzeldi');
      expect(alertMails().filter((mail) => mail.data!.noticeKind === 'RESOLVED')).toHaveLength(2);
    });

    it('never alerts about a switched-off job, and closes an open alert when the job is switched off', async () => {
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();
      expect(await alerts()).toHaveLength(0);

      await switchOn('requestExpirySchedulerEnabled');
      await evaluator().evaluate();
      expect(await alerts()).toHaveLength(1);

      await switchOff('requestExpirySchedulerEnabled');
      await evaluator().evaluate();
      expect(await alerts()).toMatchObject([{ state: 'RESOLVED', resolution: 'DISABLED' }]);
      expect(alertMails().at(-1)!.data).toMatchObject({ noticeKind: 'RESOLVED' });
      expect(alertMails().at(-1)!.data!.summary).toContain('kapatıldı');
    });

    it('does not alert about a job before its first tick is due, and does alert when it never came', async () => {
      vi.stubEnv('REQUEST_REMINDER_SCHEDULER_CRON', '45 * * * *');
      // Switched on with no recorded change: nothing to measure lateness from.
      await switchOn('requestReminderSchedulerEnabled');
      await evaluator().evaluate();
      expect(await alerts()).toHaveLength(0);

      // Switched on six hours ago and never run: three hourly ticks missed.
      await ctx.prisma.operationsSettingsChange.create({
        data: {
          setting: 'requestReminderSchedulerEnabled',
          previousValue: 'false',
          newValue: 'true',
          changedById: (await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN })).id,
          createdAt: ago(6 * HOUR),
        },
      });
      ctx.app.get(SystemHealthService).clearCache();
      await evaluator().evaluate();
      expect(await alerts()).toMatchObject([{ subjectKey: 'request-reminder', condition: 'OVERDUE', severity: 'CRITICAL' }]);
      expect(telegramSent[0]).toContain('zamanında çalışmadı');

      // A run starts: lateness is over.
      await ctx.prisma.schedulerRun.create({
        data: { jobKey: 'request-reminder', status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
      });
      await evaluator().evaluate();
      expect(await alerts()).toMatchObject([{ state: 'RESOLVED', resolution: 'RECOVERED' }]);
    });
  });

  describe('e-mail', () => {
    it('opens one alert per error class, ignores recipient-level failures and counts what is new', async () => {
      await failedEmail('TRANSPORT_UNAVAILABLE', ago(5 * MINUTE), 'offer-received');
      await failedEmail('TRANSPORT_UNAVAILABLE', ago(4 * MINUTE), 'password-reset');
      await failedEmail('INVALID_RECIPIENT', ago(4 * MINUTE));
      await failedEmail('RECIPIENT_RELEASED', ago(4 * MINUTE));
      // Older than the first evaluation's look-back: history, not news.
      await failedEmail('TIMEOUT', ago(3 * HOUR));

      await evaluator().evaluate();
      const [alert, ...rest] = await alerts();
      expect(rest).toHaveLength(0);
      expect(alert).toMatchObject({
        source: 'EMAIL',
        subjectKey: 'TRANSPORT_UNAVAILABLE',
        condition: 'SEND_FAILURES',
        severity: 'CRITICAL',
        occurrenceCount: 2,
        detail: { templates: ['offer-received', 'password-reset'] },
      });

      // The next tick reads only what came after the cursor.
      await evaluator().evaluate();
      expect((await alerts())[0]!.occurrenceCount).toBe(2);
      // Two minutes on (the cursor as a tick then would have left it), one more failure.
      await ctx.prisma.opsAlertEngineState.update({ where: { id: OPS_ALERT_ENGINE_STATE_ID }, data: { emailCursor: ago(2 * MINUTE) } });
      await failedEmail('TRANSPORT_UNAVAILABLE', ago(MINUTE));
      await evaluator().evaluate();
      expect((await alerts())[0]!.occurrenceCount).toBe(3);
      expect(alertMails()).toHaveLength(1);
      expect(telegramSent).toHaveLength(1);
    });

    it('recovers only after 30 quiet minutes and a message that really left', async () => {
      await failedEmail('TIMEOUT', ago(20 * MINUTE));
      await evaluator().evaluate();
      const [alert] = await alerts();
      expect(alert).toMatchObject({ severity: 'WARNING', state: 'OPEN' });

      // Quiet, but nothing sent: not recovered.
      await ctx.prisma.opsAlert.update({ where: { id: alert!.id }, data: { lastSeenAt: ago(EMAIL_RECOVERY_QUIET_MS + MINUTE), firstSeenAt: ago(HOUR) } });
      await evaluator().evaluate();
      expect((await alerts())[0]!.state).toBe('OPEN');

      // A send before the last failure is not evidence either.
      await sentEmail(ago(2 * HOUR));
      await evaluator().evaluate();
      expect((await alerts())[0]!.state).toBe('OPEN');

      // Sent after the last failure, but the failure is recent: not yet.
      await ctx.prisma.opsAlert.update({ where: { id: alert!.id }, data: { lastSeenAt: ago(10 * MINUTE) } });
      await sentEmail(ago(5 * MINUTE));
      await evaluator().evaluate();
      expect((await alerts())[0]!.state).toBe('OPEN');

      // Thirty quiet minutes and a sent message: recovered, once.
      await ctx.prisma.opsAlert.update({ where: { id: alert!.id }, data: { lastSeenAt: ago(EMAIL_RECOVERY_QUIET_MS + 5 * MINUTE) } });
      await evaluator().evaluate();
      await evaluator().evaluate();
      expect((await alerts())[0]).toMatchObject({ state: 'RESOLVED', resolution: 'RECOVERED' });
      expect(alertMails().map((mail) => mail.data!.noticeKind)).toEqual(['OPENED', 'RESOLVED']);
    });
  });

  describe('delivery', () => {
    it('keeps the channels apart: e-mail down does not hold Telegram, and is retried until it lands', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      ctx.notifications.failNextSend = true;

      await evaluator().evaluate();
      const [email, telegram] = await deliveries();
      expect(telegram).toMatchObject({ channel: 'TELEGRAM', status: 'SENT' });
      expect(email).toMatchObject({ channel: 'EMAIL', status: 'FAILED', attemptCount: 1, errorCode: 'TRANSPORT_UNAVAILABLE' });
      expect(email!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 4 * MINUTE);

      // Not due yet: the next pass leaves it alone.
      await worker().deliverDue();
      expect((await deliveries({ channel: 'EMAIL' }))[0]!.attemptCount).toBe(1);

      await makeDue();
      await worker().deliverDue();
      expect(await deliveries({ channel: 'EMAIL' })).toMatchObject([{ status: 'SENT', attemptCount: 2, errorCode: null }]);
      expect(telegramSent).toHaveLength(1);
      // Neither the failure nor the retry produced an alert of its own.
      expect(await alerts()).toHaveLength(1);
      expect(await ctx.prisma.notificationLog.count()).toBe(0);
    });

    it('abandons a delivery after the last attempt, and the failing channel never raises an alert', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      telegramFails = Array.from({ length: DELIVERY_MAX_ATTEMPTS }, () => () => new TelegramSendError('TRANSPORT_UNAVAILABLE'));

      await evaluator().evaluate();
      for (let attempt = 2; attempt <= DELIVERY_MAX_ATTEMPTS + 1; attempt += 1) {
        await makeDue();
        await evaluator().evaluate();
      }

      expect(await deliveries({ channel: 'TELEGRAM' })).toMatchObject([
        { status: 'ABANDONED', attemptCount: DELIVERY_MAX_ATTEMPTS, errorCode: 'TRANSPORT_UNAVAILABLE' },
      ]);
      expect(await deliveries({ channel: 'EMAIL' })).toMatchObject([{ status: 'SENT', attemptCount: 1 }]);
      expect(await alerts()).toHaveLength(1);
      expect(await ctx.prisma.opsAlert.count({ where: { source: OpsAlertSource.EMAIL } })).toBe(0);
      expect(await ctx.prisma.schedulerRun.count()).toBe(1);
    });

    it('an alert e-mail that keeps failing is not an e-mail failure the engine reads back (no loop)', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(5 * MINUTE));
      vi.spyOn(ctx.notifications, 'send').mockRejectedValue(Object.assign(new Error('provider said: rcpt=ops@x'), { errorCode: 'TRANSPORT_UNAVAILABLE' }));

      for (let tick = 0; tick < 4; tick += 1) {
        await makeDue();
        await evaluator().evaluate();
      }
      expect(await alerts()).toHaveLength(1);
      expect(await ctx.prisma.notificationLog.count()).toBe(0);
      const [delivery] = await deliveries();
      expect(delivery).toMatchObject({ status: 'FAILED', attemptCount: 4, errorCode: 'TRANSPORT_UNAVAILABLE' });
    });

    it('cancels notices that never went out when the problem clears, and sends no recovery for them', async () => {
      vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', '');
      vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', '');
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      ctx.notifications.failNextSend = true;
      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([{ status: 'FAILED' }]);

      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([{ kind: 'OPENED', status: 'CANCELLED', errorCode: 'ALERT_CLOSED' }]);
      expect(alertMails()).toHaveLength(0);
    });

    it('re-sends a timed-out e-mail under the same idempotency key; a timed-out Telegram message may arrive twice, with the same event id', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));

      // Both providers accept the message but the answer never comes back.
      const offered: Array<{ key: string | undefined; ref: string | undefined }> = [];
      const originalSend = ctx.notifications.send.bind(ctx.notifications);
      let emailTimedOut = false;
      vi.spyOn(ctx.notifications, 'send').mockImplementation(async (message) => {
        offered.push({ key: message.idempotencyKey, ref: message.data?.alertRef ?? undefined });
        const result = await originalSend(message);
        if (!emailTimedOut) {
          emailTimedOut = true;
          throw Object.assign(new Error('timeout'), { errorCode: 'TIMEOUT' });
        }
        return result;
      });
      let telegramTimedOut = false;
      vi.spyOn(ctx.app.get(TelegramAlertPort), 'send').mockImplementation(async (text) => {
        telegramSent.push(text);
        if (!telegramTimedOut) {
          telegramTimedOut = true;
          throw new TelegramSendError('TIMEOUT');
        }
        return { providerMessageId: 'tg' };
      });

      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([
        { channel: 'EMAIL', status: 'FAILED', errorCode: 'TIMEOUT' },
        { channel: 'TELEGRAM', status: 'FAILED', errorCode: 'TIMEOUT' },
      ]);
      await makeDue();
      await worker().deliverDue();
      expect(await deliveries()).toMatchObject([
        { channel: 'EMAIL', status: 'SENT', attemptCount: 2 },
        { channel: 'TELEGRAM', status: 'SENT', attemptCount: 2 },
      ]);

      // E-mail: the provider sees one key twice and de-duplicates.
      expect(offered).toHaveLength(2);
      expect(offered[0]!.key).toBe(offered[1]!.key);
      // Telegram: the chat may see it twice — the same text, the same event id.
      const [alert] = await alerts();
      expect(telegramSent).toHaveLength(2);
      expect(telegramSent[0]).toBe(telegramSent[1]);
      expect(telegramSent[0]).toContain(alert!.ref);
    });
  });

  describe('frozen notice content (OBS-ALERT-002)', () => {
    it('a retry sends the content frozen at queue time', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      ctx.notifications.failNextSend = true;
      await evaluator().evaluate();
      const [email] = await deliveries({ channel: 'EMAIL' });
      expect(email).toMatchObject({ status: 'FAILED' });
      const frozen = email!.noticeSnapshot as { v: number; severity: string; emailData: Record<string, string> };
      expect(frozen).toMatchObject({ v: 1, emailData: { occurrenceCount: '1' } });

      // The alert moves on before the retry.
      await ctx.prisma.opsAlert.updateMany({ data: { occurrenceCount: 7 } });
      const offered: Array<{ key: string | undefined; count: string | null | undefined }> = [];
      const originalSend = ctx.notifications.send.bind(ctx.notifications);
      vi.spyOn(ctx.notifications, 'send').mockImplementation(async (message) => {
        offered.push({ key: message.idempotencyKey, count: message.data?.occurrenceCount });
        return originalSend(message);
      });
      await makeDue();
      await worker().deliverDue();

      expect(offered).toEqual([{ key: opsAlertIdempotencyKey(email!.id), count: '1' }]);
      expect(alertMails()[0]!.recipientLogPolicy).toBe('hidden');
    });

    it('queues every row with the alert as it is at that moment', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();
      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();

      const rows = await deliveries();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) expect(row.noticeSnapshot).not.toBeNull();
      const resolved = rows.find((row) => row.kind === 'RESOLVED' && row.channel === 'EMAIL');
      expect(resolved!.noticeSnapshot).toMatchObject({ v: 1, emailData: { noticeKind: 'RESOLVED' } });
      expect((resolved!.noticeSnapshot as { emailData: Record<string, string> }).emailData.resolvedAt).not.toBe('');
    });

    it('rows queued before the snapshot column compose live', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      ctx.notifications.failNextSend = true;
      await evaluator().evaluate();
      await ctx.prisma.opsAlertDelivery.updateMany({ data: { noticeSnapshot: Prisma.DbNull } });
      await ctx.prisma.opsAlert.updateMany({ data: { occurrenceCount: 9 } });

      await makeDue();
      await worker().deliverDue();
      expect(alertMails().at(-1)!.data).toMatchObject({ occurrenceCount: '9' });
    });

    it('reads a snapshot strictly: anything else is null', () => {
      const good = snapshotNotice(
        'OPENED',
        {
          ref: 'OPS-ABCDEFGH23',
          source: OpsAlertSource.SCHEDULER,
          subjectKey: 'request-expiry',
          condition: 'OVERDUE',
          severity: OpsAlertSeverity.WARNING,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          occurrenceCount: 1,
          resolvedAt: null,
          resolution: null,
          detail: {},
        },
        null,
      );
      expect(readNoticeSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good);
      for (const bad of [
        null,
        'x',
        [],
        { ...good, v: 2 },
        { ...good, severity: 'INFO' },
        { ...good, telegramText: 5 },
        { ...good, emailData: { a: 1 } },
        { ...good, emailData: ['a'] },
        { ...good, emailData: null },
      ]) {
        expect(readNoticeSnapshot(bad)).toBeNull();
      }
    });
  });

  describe('concurrency and restarts', () => {
    it('lets parallel evaluators open each alert once and send each notice once', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled', 'requestExpirySchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      await run('request-expiry', 'FAILED', ago(5 * MINUTE));
      await failedEmail('TRANSPORT_UNAVAILABLE', ago(5 * MINUTE));

      // From an empty engine state: the first evaluators also race to create its row.
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => evaluator().evaluate()));
      expect(outcomes).toContain('EVALUATED');
      expect(outcomes.every((outcome) => outcome === 'EVALUATED' || outcome === 'BUSY')).toBe(true);

      expect(await alerts()).toHaveLength(3);
      const rows = await deliveries();
      expect(rows.every((row) => row.status === 'SENT' && row.attemptCount === 1)).toBe(true);
      // OPENED: e-mail ×3, Telegram for the two CRITICAL ones.
      expect(rows).toHaveLength(5);
      expect(alertMails()).toHaveLength(3);
      expect(telegramSent).toHaveLength(2);
    });

    it('lets a delivery be claimed by one worker only', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      await evaluator().evaluateOnly();
      expect(await deliveries()).toMatchObject([{ status: 'PENDING' }, { status: 'PENDING' }]);

      const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => worker().claim(`token-${index}`)));
      const all = claims.flat();
      expect(all).toHaveLength(2);
      expect(new Set(all).size).toBe(2);
      // A held claim is not taken while its lease is live…
      expect(await worker().claim('late-comer')).toEqual([]);
      // …and once it ran out, the next worker takes it and sends it.
      await ctx.prisma.opsAlertDelivery.updateMany({ data: { claimedAt: ago(DELIVERY_LEASE_MS + MINUTE) } });
      const pass = await worker().deliverDue();
      expect(pass).toMatchObject({ claimed: 2, sent: 2 });
      expect(await deliveries()).toMatchObject([
        { status: 'SENT', attemptCount: 2, claimToken: null },
        { status: 'SENT', attemptCount: 2, claimToken: null },
      ]);
    });

    it('abandons a claim that ran out on its last attempt instead of trying again', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(5 * MINUTE));
      await evaluator().evaluateOnly();
      await worker().claim('stuck');
      await ctx.prisma.opsAlertDelivery.updateMany({
        data: { claimedAt: ago(DELIVERY_LEASE_MS + MINUTE), attemptCount: DELIVERY_MAX_ATTEMPTS },
      });
      await worker().deliverDue();
      expect(await deliveries()).toMatchObject([{ status: 'ABANDONED', errorCode: 'LEASE_EXPIRED', claimToken: null }]);
      expect(alertMails()).toHaveLength(0);
    });

    it('survives a restart: a new process neither re-opens nor re-sends, and resolves what the old one opened', async () => {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(10 * MINUTE));
      await evaluator().evaluate();
      expect(telegramSent).toHaveLength(1);

      const second = await createTestApp();
      try {
        wireTelegram(second.app);
        await second.app.get(OpsAlertEvaluator).evaluate();
        await second.app.get(OpsAlertEvaluator).evaluate();
        expect(await alerts()).toHaveLength(1);
        expect(second.notifications.ofTemplate('ops-alert')).toHaveLength(0);
        expect(telegramSent).toHaveLength(1);

        await run('unviewed-offer-refund', 'SUCCESS', ago(MINUTE));
        await second.app.get(OpsAlertEvaluator).evaluate();
        expect(await alerts()).toMatchObject([{ state: 'RESOLVED', resolution: 'RECOVERED' }]);
        expect(second.notifications.ofTemplate('ops-alert').map((mail) => mail.data!.noticeKind)).toEqual(['RESOLVED']);
        expect(telegramSent).toHaveLength(2);
      } finally {
        await second.app.close();
      }
    });

    it('picks up a delivery a stopped process left mid-send', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(5 * MINUTE));
      await evaluator().evaluateOnly();
      // The old process claimed it and died before recording anything.
      await worker().claim('dead-process');
      await ctx.prisma.opsAlertDelivery.updateMany({ data: { claimedAt: ago(DELIVERY_LEASE_MS + MINUTE) } });

      await evaluator().evaluate();
      expect(await deliveries()).toMatchObject([{ status: 'SENT', attemptCount: 2 }]);
      expect(alertMails()).toHaveLength(1);
    });
  });

  describe('the engine itself', () => {
    it('records its own failure by type, alerts nothing and stays out of what it watches', async () => {
      await switchOn('requestExpirySchedulerEnabled');
      await run('request-expiry', 'FAILED', ago(5 * MINUTE));
      vi.spyOn(ctx.app.get(SystemHealthService), 'readSchedulerFacts').mockRejectedValue(
        new Prisma.PrismaClientInitializationError("Can't reach database server at `db-secret-host:5432`", '6.0.0'),
      );

      expect(await evaluator().evaluate()).toBe('FAILED');
      const state = await ctx.prisma.opsAlertEngineState.findUnique({ where: { id: OPS_ALERT_ENGINE_STATE_ID } });
      expect(state).toMatchObject({ lastErrorType: 'DATABASE_ERROR', lastSucceededAt: null });
      expect(state!.lastFailedAt).not.toBeNull();
      expect(await alerts()).toHaveLength(0);
      expect(await ctx.prisma.schedulerRun.count()).toBe(1);
      expect(await ctx.prisma.notificationLog.count()).toBe(0);
    });

    it('records its last success and moves the e-mail cursor', async () => {
      const before = Date.now();
      await evaluator().evaluate();
      const state = await ctx.prisma.opsAlertEngineState.findUnique({ where: { id: OPS_ALERT_ENGINE_STATE_ID } });
      expect(state!.lastSucceededAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(state!.emailCursor!.getTime()).toBeLessThan(Date.now());
    });
  });

  describe('the health report (RBAC and privacy)', () => {
    const fetchReport = (cookie?: string) => {
      const call = request(ctx.server).get('/system-health');
      return cookie ? call.set('Cookie', cookie) : call;
    };
    async function sessionWith(permissions: AdminPermission[]) {
      const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
      return loginAs(ctx.prisma, admin.id);
    }

    async function seedBoth() {
      await switchOn('unviewedOfferRefundSchedulerEnabled');
      await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
      await failedEmail('TRANSPORT_UNAVAILABLE', ago(5 * MINUTE));
      await evaluator().evaluate();
    }

    it('shows the engine, the channels and scheduler alerts to OPERATIONS_SETTINGS_READ — without e-mail alerts', async () => {
      await seedBoth();
      const response = await fetchReport(await sessionWith([AdminPermission.OPERATIONS_SETTINGS_READ])).expect(200);
      const block = response.body.alerts;
      expect(block).toMatchObject({ status: 'HEALTHY', reason: 'OK', channels: { email: true, telegram: true } });
      expect(block.engine.lastSucceededAt).toEqual(expect.any(String));
      expect(block.open).toHaveLength(1);
      expect(block.open[0]).toMatchObject({ source: 'SCHEDULER', subjectKey: 'unviewed-offer-refund', severity: 'CRITICAL' });
      expect(block.open[0].ref).toMatch(/^OPS-/);
      expect(block.open[0].deliveries).toHaveLength(2);
      expect(block.open[0].deliveries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'OPENED', channel: 'EMAIL', status: 'SENT' }),
          expect.objectContaining({ kind: 'OPENED', channel: 'TELEGRAM', status: 'SENT' }),
        ]),
      );
      expect(JSON.stringify(block)).not.toMatch(/TRANSPORT_UNAVAILABLE|SEND_FAILURES|"EMAIL","subjectKey"/);
    });

    it('adds e-mail alerts for a NOTIFICATION_LOGS_READ holder; that permission alone opens nothing', async () => {
      await seedBoth();
      const both = await fetchReport(
        await sessionWith([AdminPermission.OPERATIONS_SETTINGS_READ, AdminPermission.NOTIFICATION_LOGS_READ]),
      ).expect(200);
      expect(both.body.alerts.open.map((alert: { source: string }) => alert.source).sort()).toEqual(['EMAIL', 'SCHEDULER']);
      await fetchReport(await sessionWith([AdminPermission.NOTIFICATION_LOGS_READ])).expect(403);
      await fetchReport().expect(401);
      const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
      await fetchReport(await loginAs(ctx.prisma, customer.id)).expect(403);
    });

    it('never carries a token, a chat id, the alert mailbox, a recipient or a message', async () => {
      await seedBoth();
      const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
      const response = await fetchReport(await loginAs(ctx.prisma, root.id)).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(TELEGRAM_TOKEN);
      expect(text).not.toContain('S3cr3t');
      expect(text).not.toContain(TELEGRAM_CHAT);
      expect(text).not.toContain(OPS_EMAIL);
      expect(text).not.toContain('c***@example.test');
      expect(text).not.toMatch(/providerMessageId|claimToken|maskedRecipient|telegramText/);
    });

    it('shows a stopped engine as late, and a late engine lifts the overall state', async () => {
      await ctx.prisma.opsAlertEngineState.create({
        data: { id: OPS_ALERT_ENGINE_STATE_ID, lastSucceededAt: ago(2 * HOUR), lastStartedAt: ago(2 * HOUR) },
      });
      vi.stubEnv('OPS_ALERT_CRON', '*/5 * * * *');
      const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
      const response = await fetchReport(await loginAs(ctx.prisma, root.id)).expect(200);
      expect(response.body.alerts).toMatchObject({ status: 'DOWN', reason: 'OVERDUE', engine: { missedTicks: 3 } });
      expect(['DEGRADED', 'DOWN']).toContain(response.body.overall);
    });

    it('offers no write verb for alerts', async () => {
      const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
      const cookie = await loginAs(ctx.prisma, root.id);
      for (const path of ['/ops-alerts', '/system-health/alerts', '/system-health/alerts/evaluate']) {
        await request(ctx.server).post(path).set('Cookie', cookie).expect(404);
      }
    });
  });

  it('keeps the severities and channels it wrote within their enums', async () => {
    await switchOn('unviewedOfferRefundSchedulerEnabled');
    await run('unviewed-offer-refund', 'FAILED', ago(5 * MINUTE));
    await evaluator().evaluate();
    const [alert] = await alerts();
    expect(Object.values(OpsAlertSeverity)).toContain(alert!.severity);
    for (const row of await deliveries()) {
      expect(Object.values(OpsAlertChannel)).toContain(row.channel);
      expect(Object.values(OpsAlertNoticeKind)).toContain(row.kind);
    }
  });
});
