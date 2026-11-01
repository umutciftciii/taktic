import { randomBytes } from 'node:crypto';
import {
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertEmailRouting,
  OpsAlertNoticeKind,
  OpsAlertRecipientAuditAction,
  Prisma,
  UserRole,
} from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/modules/auth/auth.types';
import { OPERATIONS_SETTINGS_ID } from '../src/modules/operations-settings/operations-settings.service';
import { DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS } from '../src/modules/offers/refund-policy';
import { OpsAlertDeliveryWorker, opsAlertIdempotencyKey } from '../src/modules/ops-alerts/ops-alert-delivery.worker';
import { OpsAlertEvaluator } from '../src/modules/ops-alerts/ops-alert-evaluator.service';
import { OPS_ALERT_ADVISORY_LOCK_KEY } from '../src/modules/ops-alerts/ops-alert.rules';
import { DuplicateRecipientError, OpsAlertRecipientsService } from '../src/modules/ops-alerts/ops-alert-recipients.service';
import {
  ConfirmCancelRequiredError,
  EnvAddressMissingError,
  IMPORTED_RECIPIENT_LABEL,
  OpsAlertRoutingService,
  RoutingBlockedError,
  RoutingCountsChangedError,
  type RoutingPreview,
} from '../src/modules/ops-alerts/ops-alert-routing.service';
import { addressHmac } from '../src/modules/ops-alerts/recipient-crypto';
import { resolveRecipientCryptoConfig } from '../src/modules/ops-alerts/recipient-crypto.config';
import { TelegramAlertPort } from '../src/modules/ops-alerts/telegram-alert.port';
import { SystemHealthService } from '../src/modules/system-health/system-health.service';
import { createTestApp, createUser, resetDatabase, type TestContext } from './harness';

/**
 * OBS-ALERT-002 — ENV_LEGACY ⇄ MANAGED, under the evaluator's lock, each way
 * behind a preview whose counts the apply must still see. No notice is lost
 * (a pending legacy row goes to the imported recipient — the same mailbox)
 * and none is redirected (a row is never moved to a different address).
 */

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const TELEGRAM_TOKEN = `123456789:${'S3cr3tT0k3n'.repeat(4)}`;
const TELEGRAM_CHAT = '-1001234567890';
const OPS_EMAIL = 'ops-alerts@example.test';

describe('OpsAlertRoutingService', () => {
  let ctx: TestContext;
  let actor: AuthUser;

  const routing = () => ctx.app.get(OpsAlertRoutingService);
  const recipients = () => ctx.app.get(OpsAlertRecipientsService);
  const evaluator = () => ctx.app.get(OpsAlertEvaluator);
  const worker = () => ctx.app.get(OpsAlertDeliveryWorker);
  const alertMails = () => ctx.notifications.ofTemplate('ops-alert');

  type Prefs = { notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean };
  const ALL: Prefs = { notifyWarning: true, notifyCritical: true, notifyRecovery: true };
  const WARN: Prefs = { notifyWarning: true, notifyCritical: false, notifyRecovery: false };
  const add = (address: string, prefs: Prefs = ALL) => recipients().create(actor, { address, label: 'Nöbetçi', ...prefs });

  const mode = async () =>
    (await ctx.prisma.opsAlertRoutingSettings.findUniqueOrThrow({ where: { id: 'ops-alert-routing' } })).emailRouting;
  const setRouting = (emailRouting: OpsAlertEmailRouting) =>
    ctx.prisma.opsAlertRoutingSettings.update({ where: { id: 'ops-alert-routing' }, data: { emailRouting } });

  const deliveries = (where: Prisma.OpsAlertDeliveryWhereInput = {}) =>
    ctx.prisma.opsAlertDelivery.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  async function switchOn(setting: 'requestExpirySchedulerEnabled' | 'unviewedOfferRefundSchedulerEnabled') {
    await ctx.prisma.operationsSettings.upsert({
      where: { id: OPERATIONS_SETTINGS_ID },
      create: { id: OPERATIONS_SETTINGS_ID, unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS, [setting]: true },
      update: { [setting]: true },
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

  /** Telegram off for this case. */
  function noTelegram() {
    vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', '');
  }

  const counts = (over: Partial<RoutingPreview['counts']> = {}): RoutingPreview['counts'] => ({
    PENDING: { rebind: 0, cancel: 0 },
    FAILED: { rebind: 0, cancel: 0 },
    SENDING: { rebind: 0, cancel: 0 },
    ...over,
  });

  async function cutover() {
    const preview = await routing().previewCutover();
    expect(preview.blockers).toEqual([]);
    await routing().applyCutover(actor, { token: preview.token });
    return preview;
  }

  async function errorOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
    try {
      await promise;
    } catch (error) {
      return error as Error & { code?: string };
    }
    return expect.unreachable('expected a refusal') as never;
  }

  async function revert(cancelUnmatched = true) {
    const preview = await routing().previewRevert();
    expect(preview.blockers).toEqual([]);
    await routing().applyRevert(actor, { token: preview.token, cancelUnmatched });
    return preview;
  }

  /** Another row for the notice `of` carries: bound to `recipientId`, or legacy when null. */
  function twin(
    of: { alertId: string; kind: OpsAlertNoticeKind; sequence: number },
    recipientId: string | null,
    status: OpsAlertDeliveryStatus,
    extra: Partial<Prisma.OpsAlertDeliveryUncheckedCreateInput> = {},
  ) {
    return ctx.prisma.opsAlertDelivery.create({
      data: {
        alertId: of.alertId,
        kind: of.kind,
        sequence: of.sequence,
        channel: OpsAlertChannel.EMAIL,
        recipientId,
        status,
        nextAttemptAt: new Date(),
        ...(status === OpsAlertDeliveryStatus.SENT ? { sentAt: new Date() } : {}),
        ...(status === OpsAlertDeliveryStatus.SENDING ? { claimToken: 'worker-0', claimedAt: new Date(), attemptCount: 1 } : {}),
        ...extra,
      },
    });
  }

  /** A worker's claim on a row, as `claim()` leaves it: SENDING under a token, lease fresh. */
  const inFlight = (id: string, token = 'worker-1') =>
    ctx.prisma.opsAlertDelivery.update({
      where: { id },
      data: { status: 'SENDING', claimToken: token, claimedAt: new Date(), attemptCount: 1 },
    });

  /**
   * The in-flight worker's outcome write, exactly as the worker writes it: only
   * while its claim is still on the row. Returns whether it landed.
   */
  async function outcome(id: string, result: 'SENT' | 'FAILED', token = 'worker-1'): Promise<boolean> {
    const data =
      result === 'SENT'
        ? { status: OpsAlertDeliveryStatus.SENT, sentAt: new Date(), errorCode: null, providerMessageId: 'in-flight' }
        : { status: OpsAlertDeliveryStatus.FAILED, errorCode: 'TIMEOUT', nextAttemptAt: ago(MINUTE) };
    const updated = await ctx.prisma.opsAlertDelivery.updateMany({
      where: { id, claimToken: token, status: OpsAlertDeliveryStatus.SENDING },
      data: { ...data, claimToken: null, claimedAt: null },
    });
    return updated.count === 1;
  }

  const makeDue = () =>
    ctx.prisma.opsAlertDelivery.updateMany({
      where: { status: { in: ['PENDING', 'FAILED'] } },
      data: { nextAttemptAt: ago(MINUTE) },
    });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.operationsSettingsChange.deleteMany();
    await ctx.prisma.operationsSettings.deleteMany();
    ctx.notifications.clear();
    vi.spyOn(ctx.app.get(TelegramAlertPort), 'send').mockImplementation(async () => ({ providerMessageId: 'tg' }));
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

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  describe('import', () => {
    it('import stores the env address encrypted with all preferences on', async () => {
      const view = await routing().importFromEnv(actor);

      expect(view).toMatchObject({
        label: IMPORTED_RECIPIENT_LABEL,
        maskedAddress: 'o*********@example.test',
        notifyWarning: true,
        notifyCritical: true,
        notifyRecovery: true,
        status: 'ACTIVE',
      });
      expect(IMPORTED_RECIPIENT_LABEL).toBe('OPS_ALERT_EMAIL (içe aktarıldı)');
      const row = await ctx.prisma.opsAlertRecipient.findUniqueOrThrow({ where: { id: view.id } });
      expect(Buffer.from(row.addressCiphertext!).toString('utf8')).not.toContain(OPS_EMAIL);
      expect(row.addressHmac).toBe(addressHmac(resolveRecipientCryptoConfig(), OPS_EMAIL).hmac);
      expect(JSON.stringify(view)).not.toContain(OPS_EMAIL);

      const audit = await ctx.prisma.opsAlertRecipientAuditLog.findMany({ where: { recipientId: view.id } });
      expect(audit.map((entry) => entry.action)).toEqual([OpsAlertRecipientAuditAction.IMPORTED_FROM_ENV]);
      expect(JSON.stringify(audit)).not.toContain(OPS_EMAIL);

      const state = await routing().state();
      expect(state).toMatchObject({
        emailRouting: 'ENV_LEGACY',
        envAddressConfigured: true,
        envAddressManaged: true,
        activeRecipients: 1,
        liveCritical: 1,
        telegramConfigured: true,
        keyIds: { v1: 1 },
        hmacVersions: { '1': 1 },
      });
    });

    it('import twice is a duplicate', async () => {
      await routing().importFromEnv(actor);
      const error = await errorOf(routing().importFromEnv(actor));
      expect(error).toBeInstanceOf(DuplicateRecipientError);
      expect(error.code).toBe('RECIPIENT_DUPLICATE');
      expect(await ctx.prisma.opsAlertRecipient.count()).toBe(1);
    });

    it('import without an env address is refused', async () => {
      vi.stubEnv('OPS_ALERT_EMAIL', '');
      const error = await errorOf(routing().importFromEnv(actor));
      expect(error).toBeInstanceOf(EnvAddressMissingError);
      expect(error.code).toBe('ENV_ADDRESS_MISSING');
      expect(await ctx.prisma.opsAlertRecipient.count()).toBe(0);
      expect((await routing().state()).envAddressConfigured).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cutover
  // -------------------------------------------------------------------------

  describe('cutover', () => {
    it('cutover binds pending legacy rows to the imported recipient and sends them there', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      expect(legacy).toMatchObject({ recipientId: null, status: 'PENDING' });
      const imported = await routing().importFromEnv(actor);

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({
        direction: 'CUTOVER',
        counts: counts({ PENDING: { rebind: 1, cancel: 0 } }),
        told: 0,
        blockers: [],
      });
      expect(preview.token).toMatch(/^[0-9a-f]{64}$/);

      const state = await routing().applyCutover(actor, { token: preview.token });
      expect(state.emailRouting).toBe('MANAGED');
      expect(state.changedAt).toBeInstanceOf(Date);
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ recipientId: imported.id, status: 'PENDING' }]);

      const audit = await ctx.prisma.opsAlertRecipientAuditLog.findMany({
        where: { action: OpsAlertRecipientAuditAction.ROUTING_CUTOVER },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ recipientId: null, actorId: actor.id, before: { emailRouting: 'ENV_LEGACY' } });
      expect(audit[0]!.after).toEqual({ emailRouting: 'MANAGED', counts: preview.counts, told: 0, inFlight: 0 });

      // The change log reads the switch: the mode on each side and the numbers, flattened.
      const page = await recipients().auditPage(null, {});
      const entry = page.items.find((item) => item.action === 'ROUTING_CUTOVER')!;
      expect(entry.target).toBeNull();
      expect(entry.changes).toEqual([
        { field: 'emailRouting', from: 'ENV_LEGACY', to: 'MANAGED' },
        { field: 'counts.PENDING.rebind', from: null, to: 1 },
        { field: 'counts.PENDING.cancel', from: null, to: 0 },
        { field: 'counts.FAILED.rebind', from: null, to: 0 },
        { field: 'counts.FAILED.cancel', from: null, to: 0 },
        { field: 'counts.SENDING.rebind', from: null, to: 0 },
        { field: 'counts.SENDING.cancel', from: null, to: 0 },
        { field: 'told', from: null, to: 0 },
        { field: 'inFlight', from: null, to: 0 },
      ]);
    });

    it('a pending legacy row at cutover is delivered to the imported recipient exactly once', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      const imported = await routing().importFromEnv(actor);
      await cutover();

      await worker().deliverDue();
      await ctx.prisma.opsAlertDelivery.updateMany({ data: { nextAttemptAt: ago(MINUTE) } });
      await worker().deliverDue();
      await evaluator().evaluate();

      expect(await deliveries({ channel: 'EMAIL' })).toMatchObject([
        { id: legacy!.id, recipientId: imported.id, status: 'SENT', attemptCount: 1 },
      ]);
      const mails = alertMails();
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: OPS_EMAIL, idempotencyKey: opsAlertIdempotencyKey(legacy!.id) });
    });

    it('cutover keeps the claim of a SENDING legacy row', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      const claimedAt = new Date();
      await ctx.prisma.opsAlertDelivery.update({
        where: { id: legacy!.id },
        data: { status: 'SENDING', claimToken: 'worker-1', claimedAt, attemptCount: 1 },
      });
      const imported = await routing().importFromEnv(actor);

      const preview = await routing().previewCutover();
      expect(preview.counts).toEqual(counts({ SENDING: { rebind: 1, cancel: 0 } }));
      // An in-flight row is counted under SENDING, not as told: told is SENT only.
      expect(preview.told).toBe(0);
      await routing().applyCutover(actor, { token: preview.token });

      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: imported.id, status: 'SENDING', claimToken: 'worker-1', claimedAt, attemptCount: 1 },
      ]);
    });

    it('cutover counts a pending legacy row the matched recipient does not want as cancel, and cancels it PREFERENCE_OFF', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      expect(legacy).toMatchObject({ recipientId: null, status: 'PENDING' });
      const imported = await routing().importFromEnv(actor);
      // The env address, now managed, takes critical and recovery notices only.
      await ctx.prisma.opsAlertRecipient.update({ where: { id: imported.id }, data: { notifyWarning: false } });

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ counts: counts({ PENDING: { rebind: 0, cancel: 1 } }), told: 0, blockers: [] });
      await routing().applyCutover(actor, { token: preview.token });

      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: imported.id, status: 'CANCELLED', errorCode: 'PREFERENCE_OFF', claimToken: null },
      ]);
      await worker().deliverDue();
      expect(alertMails()).toEqual([]);
    });

    it('cutover reads the frozen severity and, for RESOLVED, the recovery preference', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [opened] = await deliveries({ channel: 'EMAIL' });
      // Frozen as CRITICAL at queue time: the alert's live WARNING does not decide.
      await ctx.prisma.opsAlertDelivery.update({
        where: { id: opened!.id },
        data: { noticeSnapshot: { ...(opened!.noticeSnapshot as object), severity: 'CRITICAL' } },
      });
      const resolved = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: opened!.alertId,
          kind: OpsAlertNoticeKind.RESOLVED,
          sequence: 0,
          channel: OpsAlertChannel.EMAIL,
          status: OpsAlertDeliveryStatus.FAILED,
          nextAttemptAt: new Date(),
        },
      });
      const imported = await routing().importFromEnv(actor);
      await ctx.prisma.opsAlertRecipient.update({
        where: { id: imported.id },
        data: { notifyWarning: false, notifyCritical: true, notifyRecovery: false },
      });

      const preview = await routing().previewCutover();
      expect(preview.counts).toEqual(counts({ PENDING: { rebind: 1, cancel: 0 }, FAILED: { rebind: 0, cancel: 1 } }));
      await routing().applyCutover(actor, { token: preview.token });

      expect(await deliveries({ id: opened!.id })).toMatchObject([{ recipientId: imported.id, status: 'PENDING' }]);
      expect(await deliveries({ id: resolved.id })).toMatchObject([
        { recipientId: imported.id, status: 'CANCELLED', errorCode: 'PREFERENCE_OFF' },
      ]);
    });

    it('a preference change between preview and apply is COUNTS_CHANGED', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const imported = await routing().importFromEnv(actor);
      const preview = await routing().previewCutover();
      expect(preview.counts).toEqual(counts({ PENDING: { rebind: 1, cancel: 0 } }));
      await ctx.prisma.opsAlertRecipient.update({ where: { id: imported.id }, data: { notifyWarning: false } });

      const error = await errorOf(routing().applyCutover(actor, { token: preview.token }));
      expect(error.code).toBe('COUNTS_CHANGED');
      expect(await mode()).toBe('ENV_LEGACY');
    });

    it('cutover carries told so a later RESOLVED reaches the imported recipient', async () => {
      await warningAlert();
      await evaluator().evaluate();
      const [told] = await deliveries({ channel: 'EMAIL' });
      expect(told).toMatchObject({ recipientId: null, status: 'SENT' });
      expect(alertMails().map((mail) => mail.to)).toEqual([OPS_EMAIL]);
      const imported = await routing().importFromEnv(actor);
      const other = await add('other@example.test', ALL);

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ counts: counts(), told: 1, blockers: [] });
      await routing().applyCutover(actor, { token: preview.token });
      expect(await deliveries({ id: told!.id })).toMatchObject([{ recipientId: imported.id, status: 'SENT' }]);

      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();

      const resolved = await deliveries({ kind: OpsAlertNoticeKind.RESOLVED, channel: 'EMAIL' });
      expect(resolved.map((row) => [row.recipientId, row.status])).toEqual([[imported.id, 'SENT']]);
      expect(resolved.some((row) => row.recipientId === other.id)).toBe(false);
      const recovery = alertMails().filter((mail) => mail.data!.noticeKind === 'RESOLVED');
      expect(recovery.map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it('cutover leaves the sent history of a resolved alert unbound', async () => {
      await warningAlert();
      await evaluator().evaluate();
      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();
      const history = await deliveries({ channel: 'EMAIL' });
      expect(history.map((row) => [row.kind, row.status, row.recipientId])).toEqual([
        ['OPENED', 'SENT', null],
        ['RESOLVED', 'SENT', null],
      ]);
      expect((await ctx.prisma.opsAlert.findFirstOrThrow()).state).toBe('RESOLVED');
      await routing().importFromEnv(actor);

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ counts: counts(), told: 0, blockers: [] });
      await routing().applyCutover(actor, { token: preview.token });

      expect((await deliveries({ channel: 'EMAIL' })).map((row) => [row.id, row.status, row.recipientId])).toEqual(
        history.map((row) => [row.id, 'SENT', null]),
      );
    });

    it('cutover cancels a legacy row whose notice the recipient already has, instead of colliding', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      const imported = await routing().importFromEnv(actor);
      const managed = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacy!.alertId,
          kind: legacy!.kind,
          sequence: legacy!.sequence,
          channel: OpsAlertChannel.EMAIL,
          recipientId: imported.id,
          status: OpsAlertDeliveryStatus.PENDING,
          nextAttemptAt: new Date(),
        },
      });

      const preview = await routing().previewCutover();
      expect(preview.counts).toEqual(counts({ PENDING: { rebind: 0, cancel: 1 } }));
      await routing().applyCutover(actor, { token: preview.token });

      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: null, status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' },
      ]);
      expect(await deliveries({ id: managed.id })).toMatchObject([{ recipientId: imported.id, status: 'PENDING' }]);
      await ctx.prisma.opsAlertDelivery.updateMany({ data: { nextAttemptAt: ago(MINUTE) } });
      await worker().deliverDue();
      expect(alertMails().map((mail) => mail.idempotencyKey)).toEqual([opsAlertIdempotencyKey(managed.id)]);
    });

    it('cutover is blocked with no live critical channel', async () => {
      noTelegram();
      await add(OPS_EMAIL, WARN);

      const preview = await routing().previewCutover();
      expect(preview.blockers).toEqual(['NO_LIVE_CRITICAL_CHANNEL']);
      const error = await errorOf(routing().applyCutover(actor, { token: preview.token }));
      expect(error).toBeInstanceOf(RoutingBlockedError);
      expect(error.code).toBe('NO_LIVE_CRITICAL_CHANNEL');
      expect(await mode()).toBe('ENV_LEGACY');

      // Telegram alone is a live critical channel.
      vi.unstubAllEnvs();
      vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
      vi.stubEnv('OPS_ALERT_TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
      vi.stubEnv('OPS_ALERT_TELEGRAM_CHAT_ID', TELEGRAM_CHAT);
      expect((await routing().previewCutover()).blockers).toEqual([]);
    });

    it('cutover is blocked when legacy rows cannot be matched', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      await add('someone-else@example.test', ALL);

      const preview = await routing().previewCutover();
      expect(preview.blockers).toEqual(['LEGACY_ROWS_UNMATCHED']);
      expect(preview.counts).toEqual(counts({ PENDING: { rebind: 0, cancel: 1 } }));
      const error = await errorOf(routing().applyCutover(actor, { token: preview.token }));
      expect(error).toBeInstanceOf(RoutingBlockedError);
      expect(error.code).toBe('LEGACY_ROWS_UNMATCHED');
      expect(await mode()).toBe('ENV_LEGACY');
      expect(await deliveries({ channel: 'EMAIL' })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);

      // A paused recipient with the env address does not count as a match.
      const resting = await add(OPS_EMAIL, ALL);
      await recipients().pause(actor, resting.id, { version: resting.version });
      expect((await routing().previewCutover()).blockers).toEqual(['LEGACY_ROWS_UNMATCHED']);
    });

    it('cutover is refused once in MANAGED', async () => {
      await routing().importFromEnv(actor);
      const preview = await cutover();
      const again = await routing().previewCutover();
      expect(again.blockers).toEqual(['ALREADY_IN_MODE']);
      const error = await errorOf(routing().applyCutover(actor, { token: preview.token }));
      expect(error.code).toBe('ALREADY_IN_MODE');
    });

    it('cutover refuses when legacy counts changed since preview', async () => {
      await routing().importFromEnv(actor);
      const preview = await routing().previewCutover();
      expect(preview.counts).toEqual(counts());

      await warningAlert();
      await evaluator().evaluateOnly();
      const error = await errorOf(routing().applyCutover(actor, { token: preview.token }));

      expect(error).toBeInstanceOf(RoutingCountsChangedError);
      expect(error.code).toBe('COUNTS_CHANGED');
      expect(await mode()).toBe('ENV_LEGACY');
      expect(await deliveries({ channel: 'EMAIL' })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);
      expect(await ctx.prisma.opsAlertRecipientAuditLog.count({ where: { action: 'ROUTING_CUTOVER' } })).toBe(0);
    });

    it('a forged token is refused', async () => {
      await routing().importFromEnv(actor);
      const preview = await routing().previewCutover();
      const revertShaped = await routing().previewRevert();
      for (const token of ['', 'abc', randomBytes(32).toString('hex'), preview.token.toUpperCase(), revertShaped.token, `${preview.token}00`]) {
        if (token === preview.token) continue;
        const error = await errorOf(routing().applyCutover(actor, { token }));
        expect(error.code).toBe('COUNTS_CHANGED');
      }
      expect(await mode()).toBe('ENV_LEGACY');
      // The genuine one still works.
      await routing().applyCutover(actor, { token: preview.token });
      expect(await mode()).toBe('MANAGED');
    });

    it('evaluator and cutover serialise on the same lock', async () => {
      await routing().importFromEnv(actor);

      // Held by someone else (an evaluator mid-tick), the cutover waits for it.
      const preview = await routing().previewCutover();
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let lockTaken!: () => void;
      const taken = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      const holder = ctx.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPS_ALERT_ADVISORY_LOCK_KEY}::bigint)`;
          lockTaken();
          await lockHeld;
        },
        { timeout: 10_000 },
      );
      await taken;
      let applied = false;
      const apply = routing()
        .applyCutover(actor, { token: preview.token })
        .then(() => {
          applied = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(applied).toBe(false);
      expect(await mode()).toBe('ENV_LEGACY');
      releaseLock();
      await holder;
      await apply;
      expect(applied).toBe(true);
      await setRouting(OpsAlertEmailRouting.ENV_LEGACY);

      // Racing a real tick: whichever goes first, no notice is mixed.
      await warningAlert();
      const fresh = await routing().previewCutover();
      const [outcome, cut] = await Promise.allSettled([
        evaluator().evaluateOnly(),
        routing().applyCutover(actor, { token: fresh.token }),
      ]);
      expect(outcome.status).toBe('fulfilled');
      const finalMode = await mode();
      if (cut.status === 'rejected') expect((cut.reason as { code?: string }).code).toBe('COUNTS_CHANGED');
      // When the apply won, the tick met its lock (BUSY) and queued nothing:
      // one more evaluation makes the check below about real rows either way.
      expect(await evaluator().evaluateOnly()).toBe('EVALUATED');
      const email = await deliveries({ channel: 'EMAIL' });
      expect(email.length).toBeGreaterThanOrEqual(1);
      if (finalMode === 'MANAGED') {
        expect(email.every((row) => row.recipientId !== null)).toBe(true);
      } else {
        expect(email.every((row) => row.recipientId === null)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Revert
  // -------------------------------------------------------------------------

  describe('revert', () => {
    it('revert keeps matching rows and requires confirmation to cancel the rest', async () => {
      const imported = await routing().importFromEnv(actor);
      const other = await add('other@example.test', WARN);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const pending = await deliveries({ channel: 'EMAIL' });
      expect(pending.map((row) => row.recipientId).sort()).toEqual([imported.id, other.id].sort());
      const mine = pending.find((row) => row.recipientId === imported.id)!;
      const theirs = pending.find((row) => row.recipientId === other.id)!;

      const preview = await routing().previewRevert();
      expect(preview).toMatchObject({
        direction: 'REVERT',
        counts: counts({ PENDING: { rebind: 1, cancel: 1 } }),
        told: 0,
        blockers: [],
      });

      const refused = await errorOf(routing().applyRevert(actor, { token: preview.token, cancelUnmatched: false }));
      expect(refused).toBeInstanceOf(ConfirmCancelRequiredError);
      expect(refused.code).toBe('CONFIRM_CANCEL_REQUIRED');
      expect(await mode()).toBe('MANAGED');
      expect(await deliveries({ id: theirs.id })).toMatchObject([{ status: 'PENDING', recipientId: other.id }]);

      const state = await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true });
      expect(state.emailRouting).toBe('ENV_LEGACY');
      expect(await deliveries({ id: mine.id })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);
      expect(await deliveries({ id: theirs.id })).toMatchObject([
        { recipientId: other.id, status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' },
      ]);

      const audit = await ctx.prisma.opsAlertRecipientAuditLog.findMany({
        where: { action: OpsAlertRecipientAuditAction.ROUTING_REVERTED },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ recipientId: null, before: { emailRouting: 'MANAGED' } });
      expect(audit[0]!.after).toEqual({ emailRouting: 'ENV_LEGACY', counts: preview.counts, told: 0, inFlight: 0 });
      const reverted = (await recipients().auditPage(null, {})).items.find((item) => item.action === 'ROUTING_REVERTED')!;
      expect(reverted.changes).toEqual(
        expect.arrayContaining([
          { field: 'emailRouting', from: 'MANAGED', to: 'ENV_LEGACY' },
          { field: 'counts.PENDING.rebind', from: null, to: 1 },
          { field: 'counts.PENDING.cancel', from: null, to: 1 },
          { field: 'told', from: null, to: 0 },
        ]),
      );

      await worker().deliverDue();
      expect(alertMails().map((mail) => mail.to)).toEqual([OPS_EMAIL]);
      expect(alertMails()[0]!.idempotencyKey).toBe(opsAlertIdempotencyKey(mine.id));
    });

    it('revert without anything to cancel needs no confirmation and carries told back', async () => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluate();
      const [sent] = await deliveries({ channel: 'EMAIL' });
      expect(sent).toMatchObject({ recipientId: imported.id, status: 'SENT' });

      const preview = await routing().previewRevert();
      expect(preview).toMatchObject({ counts: counts(), told: 1, blockers: [] });
      await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: false });
      expect(await deliveries({ id: sent!.id })).toMatchObject([{ recipientId: null, status: 'SENT' }]);

      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();
      const recovery = alertMails().filter((mail) => mail.data!.noticeKind === 'RESOLVED');
      expect(recovery.map((mail) => mail.to)).toEqual([OPS_EMAIL]);
      expect(await deliveries({ kind: OpsAlertNoticeKind.RESOLVED, channel: 'EMAIL' })).toMatchObject([
        { recipientId: null, status: 'SENT' },
      ]);
    });

    it('revert counts an in-flight matched row under SENDING, not as told', async () => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const [mine] = await deliveries({ channel: 'EMAIL' });
      await ctx.prisma.opsAlertDelivery.update({
        where: { id: mine!.id },
        data: { status: 'SENDING', claimToken: 'worker-1', claimedAt: new Date(), attemptCount: 1 },
      });
      expect(mine!.recipientId).toBe(imported.id);

      const preview = await routing().previewRevert();
      expect(preview).toMatchObject({ counts: counts({ SENDING: { rebind: 1, cancel: 0 } }), told: 0, blockers: [] });
    });

    it('revert does not collide with a legacy row for the same notice', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacyPending] = await deliveries({ channel: 'EMAIL' });
      const imported = await routing().importFromEnv(actor);
      await cutover();
      // A second notice: a legacy SENT row and the imported recipient's SENT row.
      const legacySent = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacyPending!.alertId,
          kind: OpsAlertNoticeKind.REMINDER,
          sequence: 1,
          channel: OpsAlertChannel.EMAIL,
          status: OpsAlertDeliveryStatus.SENT,
          nextAttemptAt: new Date(),
          sentAt: new Date(),
        },
      });
      const managedSent = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacyPending!.alertId,
          kind: OpsAlertNoticeKind.REMINDER,
          sequence: 1,
          channel: OpsAlertChannel.EMAIL,
          recipientId: imported.id,
          status: OpsAlertDeliveryStatus.SENT,
          nextAttemptAt: new Date(),
          sentAt: new Date(),
        },
      });
      // A third notice: a legacy PENDING row and the recipient's PENDING row.
      const legacyThird = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacyPending!.alertId,
          kind: OpsAlertNoticeKind.REMINDER,
          sequence: 2,
          channel: OpsAlertChannel.EMAIL,
          status: OpsAlertDeliveryStatus.PENDING,
          nextAttemptAt: new Date(),
        },
      });
      const managedThird = await ctx.prisma.opsAlertDelivery.create({
        data: {
          alertId: legacyPending!.alertId,
          kind: OpsAlertNoticeKind.REMINDER,
          sequence: 2,
          channel: OpsAlertChannel.EMAIL,
          recipientId: imported.id,
          status: OpsAlertDeliveryStatus.PENDING,
          nextAttemptAt: new Date(),
        },
      });

      const preview = await routing().previewRevert();
      // legacyPending (bound at cutover) is un-bound; managedThird collides and is cancelled.
      expect(preview.counts).toEqual(counts({ PENDING: { rebind: 1, cancel: 1 } }));
      expect(preview.told).toBe(0);
      await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true });

      expect(await deliveries({ id: legacyPending!.id })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);
      expect(await deliveries({ id: managedSent.id })).toMatchObject([{ recipientId: imported.id, status: 'SENT' }]);
      expect(await deliveries({ id: legacySent.id })).toMatchObject([{ recipientId: null, status: 'SENT' }]);
      expect(await deliveries({ id: managedThird.id })).toMatchObject([
        { recipientId: imported.id, status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' },
      ]);
      expect(await deliveries({ id: legacyThird.id })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);
    });

    it('revert refuses a stale preview and a mode it is already in', async () => {
      const preview = await routing().previewRevert();
      expect(preview.blockers).toEqual(['ALREADY_IN_MODE']);
      expect((await errorOf(routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true }))).code).toBe(
        'ALREADY_IN_MODE',
      );

      await routing().importFromEnv(actor);
      await cutover();
      const stale = await routing().previewRevert();
      await warningAlert();
      await evaluator().evaluateOnly();
      const error = await errorOf(routing().applyRevert(actor, { token: stale.token, cancelUnmatched: true }));
      expect(error).toBeInstanceOf(RoutingCountsChangedError);
      expect(await mode()).toBe('MANAGED');
    });
  });

  // -------------------------------------------------------------------------
  // Round trips, collisions and rows in flight
  // -------------------------------------------------------------------------

  describe('round trips', () => {
    /** Every e-mail of one notice that reached the fake outbox. */
    const mailsOf = (ids: string[]) => alertMails().filter((mail) => ids.some((id) => mail.idempotencyKey === opsAlertIdempotencyKey(id)));

    it('cutover → revert → cutover with a collision loses nothing and sends once', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      const imported = await routing().importFromEnv(actor);
      const managed = await twin(legacy!, imported.id, OpsAlertDeliveryStatus.PENDING);

      // Both pending: the recipient's own row delivers, the legacy copy goes.
      expect((await cutover()).counts).toEqual(counts({ PENDING: { rebind: 0, cancel: 1 } }));
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);

      // Going back now would cancel the only live copy: the revert waits.
      const waiting = await routing().previewRevert();
      expect(waiting.blockers).toEqual(['ROUTING_COLLISION_PENDING']);
      expect(waiting.collisions).toBe(1);
      const error = await errorOf(routing().applyRevert(actor, { token: waiting.token, cancelUnmatched: true }));
      expect(error).toBeInstanceOf(RoutingBlockedError);
      expect(error.code).toBe('ROUTING_COLLISION_PENDING');
      expect(await mode()).toBe('MANAGED');
      expect(await deliveries({ id: managed.id })).toMatchObject([{ recipientId: imported.id, status: 'PENDING' }]);

      // The worker delivers it where it is; then the switch is free.
      await worker().deliverDue();
      expect(await deliveries({ id: managed.id })).toMatchObject([{ status: 'SENT' }]);
      const back = await revert();
      expect(back).toMatchObject({ counts: counts(), told: 0, inFlight: 0, collisions: 0 });
      expect(await deliveries({ id: managed.id })).toMatchObject([{ recipientId: imported.id, status: 'SENT' }]);
      expect((await cutover()).collisions).toBe(0);

      await makeDue();
      await worker().deliverDue();
      expect(mailsOf([legacy!.id, managed.id]).map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it('revert → cutover with a collision loses nothing and sends once', async () => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const [managed] = await deliveries({ channel: 'EMAIL' });
      expect(managed).toMatchObject({ recipientId: imported.id, status: 'PENDING' });
      const legacy = await twin(managed!, null, OpsAlertDeliveryStatus.PENDING);

      // Both pending: the legacy row delivers in ENV_LEGACY, the managed copy goes.
      expect((await revert()).counts).toEqual(counts({ PENDING: { rebind: 0, cancel: 1 } }));
      expect(await deliveries({ id: managed!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' }]);

      const waiting = await routing().previewCutover();
      expect(waiting).toMatchObject({ blockers: ['ROUTING_COLLISION_PENDING'], collisions: 1 });
      expect((await errorOf(routing().applyCutover(actor, { token: waiting.token }))).code).toBe('ROUTING_COLLISION_PENDING');
      expect(await deliveries({ id: legacy.id })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);

      await worker().deliverDue();
      expect(await deliveries({ id: legacy.id })).toMatchObject([{ recipientId: null, status: 'SENT' }]);
      expect(await cutover()).toMatchObject({ counts: counts(), collisions: 0 });
      await revert();

      await makeDue();
      await worker().deliverDue();
      expect(mailsOf([legacy.id, managed!.id]).map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it.each([
      ['SENT', 'cancels the legacy copy', null],
      ['PENDING', 'cancels the legacy copy', null],
      ['FAILED', 'cancels the legacy copy', null],
      ['SENDING', 'waits', 'ROUTING_COLLISION_PENDING'],
      ['CANCELLED', 'waits', 'ROUTING_COLLISION_PENDING'],
      ['ABANDONED', 'waits', 'ROUTING_COLLISION_PENDING'],
    ] as const)('cutover beside a %s managed row %s', async (partner, _what, blocker) => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      const imported = await routing().importFromEnv(actor);
      const managed = await twin(legacy!, imported.id, partner);

      const preview = await routing().previewCutover();
      if (blocker) {
        expect(preview).toMatchObject({ blockers: [blocker], collisions: 1, counts: counts() });
        expect((await errorOf(routing().applyCutover(actor, { token: preview.token }))).code).toBe(blocker);
        expect(await deliveries({ id: legacy!.id })).toMatchObject([{ recipientId: null, status: 'PENDING' }]);
        return;
      }
      expect(preview).toMatchObject({ blockers: [], collisions: 0, counts: counts({ PENDING: { rebind: 0, cancel: 1 } }) });
      await routing().applyCutover(actor, { token: preview.token });
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);
      expect(await deliveries({ id: managed.id })).toMatchObject([{ recipientId: imported.id, status: partner }]);
    });

    it.each([
      ['SENT', 'cancels the managed copy', null],
      ['PENDING', 'cancels the managed copy', null],
      ['FAILED', 'cancels the managed copy', null],
      ['SENDING', 'waits', 'ROUTING_COLLISION_PENDING'],
      ['CANCELLED', 'waits', 'ROUTING_COLLISION_PENDING'],
      ['ABANDONED', 'waits', 'ROUTING_COLLISION_PENDING'],
    ] as const)('revert beside a %s legacy row %s', async (partner, _what, blocker) => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const [managed] = await deliveries({ channel: 'EMAIL' });
      const legacy = await twin(managed!, null, partner);

      const preview = await routing().previewRevert();
      if (blocker) {
        expect(preview).toMatchObject({ blockers: [blocker], collisions: 1, counts: counts() });
        expect((await errorOf(routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true }))).code).toBe(blocker);
        expect(await deliveries({ id: managed!.id })).toMatchObject([{ recipientId: imported.id, status: 'PENDING' }]);
        return;
      }
      expect(preview).toMatchObject({ blockers: [], collisions: 0, counts: counts({ PENDING: { rebind: 0, cancel: 1 } }) });
      await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true });
      expect(await deliveries({ id: managed!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' }]);
      expect(await deliveries({ id: legacy.id })).toMatchObject([{ recipientId: null, status: partner }]);
    });

    it('a SENT legacy row beside a pending managed row holds the cutover until the worker drops the duplicate', async () => {
      await warningAlert();
      await evaluator().evaluate();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      expect(legacy).toMatchObject({ recipientId: null, status: 'SENT' });
      const imported = await routing().importFromEnv(actor);
      const managed = await twin(legacy!, imported.id, OpsAlertDeliveryStatus.PENDING);
      ctx.notifications.clear();

      expect((await routing().previewCutover()).blockers).toEqual(['ROUTING_COLLISION_PENDING']);
      // ENV_LEGACY: the env address's copy was sent, the bound duplicate is dropped.
      await worker().deliverDue();
      expect(await deliveries({ id: managed.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' }]);
      await cutover();
      await makeDue();
      await worker().deliverDue();
      expect(alertMails()).toEqual([]);
    });

    it('a SENT managed row beside a pending legacy row holds the revert until the worker drops the duplicate', async () => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluate();
      const [managed] = await deliveries({ channel: 'EMAIL' });
      expect(managed).toMatchObject({ recipientId: imported.id, status: 'SENT' });
      const legacy = await twin(managed!, null, OpsAlertDeliveryStatus.FAILED);
      ctx.notifications.clear();

      expect((await routing().previewRevert()).blockers).toEqual(['ROUTING_COLLISION_PENDING']);
      // MANAGED: the recipient's copy was sent, the legacy duplicate is dropped.
      await worker().deliverDue();
      expect(await deliveries({ id: legacy.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);
      await revert();
      await makeDue();
      await worker().deliverDue();
      expect(alertMails()).toEqual([]);
    });
  });

  describe('rows in flight', () => {
    it('cutover rebinds an in-flight row the recipient does not want, keeping its claim; a send that lands is SENT and told', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      await inFlight(legacy!.id);
      const imported = await routing().importFromEnv(actor);
      await ctx.prisma.opsAlertRecipient.update({ where: { id: imported.id }, data: { notifyWarning: false } });

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ counts: counts({ SENDING: { rebind: 1, cancel: 0 } }), inFlight: 0, blockers: [] });
      await routing().applyCutover(actor, { token: preview.token });
      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: imported.id, status: 'SENDING', claimToken: 'worker-1' },
      ]);

      // The send that was in flight lands: recorded truthfully, and it tells the recipient.
      expect(await outcome(legacy!.id, 'SENT')).toBe(true);
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ recipientId: imported.id, status: 'SENT' }]);
      await run('request-expiry', 'SUCCESS', ago(MINUTE));
      await evaluator().evaluate();
      expect(await deliveries({ kind: OpsAlertNoticeKind.RESOLVED, channel: 'EMAIL' })).toMatchObject([
        { recipientId: imported.id, status: 'SENT' },
      ]);
    });

    it('a failed in-flight send the recipient does not want is cancelled PREFERENCE_OFF on the retry', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      await inFlight(legacy!.id);
      const imported = await routing().importFromEnv(actor);
      await ctx.prisma.opsAlertRecipient.update({ where: { id: imported.id }, data: { notifyWarning: false } });
      await cutover();

      expect(await outcome(legacy!.id, 'FAILED')).toBe(true);
      await worker().deliverDue();
      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: imported.id, status: 'CANCELLED', errorCode: 'PREFERENCE_OFF' },
      ]);
      expect(alertMails()).toEqual([]);
    });

    it('cutover leaves an in-flight legacy row beside a SENT managed row to the worker', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      await inFlight(legacy!.id);
      const imported = await routing().importFromEnv(actor);
      await twin(legacy!, imported.id, OpsAlertDeliveryStatus.SENT);

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ counts: counts(), inFlight: 1, collisions: 0, blockers: [] });
      await routing().applyCutover(actor, { token: preview.token });
      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: null, status: 'SENDING', claimToken: 'worker-1' },
      ]);

      // It fails: the retry finds the recipient's own row and sends nothing.
      expect(await outcome(legacy!.id, 'FAILED')).toBe(true);
      await worker().deliverDue();
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'LEGACY_AFTER_CUTOVER' }]);
      expect(alertMails()).toEqual([]);
    });

    it("revert leaves the match's in-flight row beside a SENT legacy row; a failed retry is cancelled, not sent again", async () => {
      const imported = await routing().importFromEnv(actor);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const [mine] = await deliveries({ channel: 'EMAIL' });
      await inFlight(mine!.id);
      await twin(mine!, null, OpsAlertDeliveryStatus.SENT);

      const preview = await routing().previewRevert();
      expect(preview).toMatchObject({ counts: counts(), inFlight: 1, collisions: 0, blockers: [] });
      // The env address already has it: nothing of another recipient's is cancelled, no confirmation.
      await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: false });
      expect(await deliveries({ id: mine!.id })).toMatchObject([
        { recipientId: imported.id, status: 'SENDING', claimToken: 'worker-1' },
      ]);

      expect(await outcome(mine!.id, 'FAILED')).toBe(true);
      await worker().deliverDue();
      expect(await deliveries({ id: mine!.id })).toMatchObject([{ status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' }]);
      expect(alertMails()).toEqual([]);
    });

    it('cutover waits for an in-flight legacy row beside a pending managed row', async () => {
      await warningAlert();
      await evaluator().evaluateOnly();
      const [legacy] = await deliveries({ channel: 'EMAIL' });
      await inFlight(legacy!.id);
      const imported = await routing().importFromEnv(actor);
      await twin(legacy!, imported.id, OpsAlertDeliveryStatus.PENDING);

      const preview = await routing().previewCutover();
      expect(preview).toMatchObject({ blockers: ['ROUTING_COLLISION_PENDING'], collisions: 1 });
      expect(await deliveries({ id: legacy!.id })).toMatchObject([{ status: 'SENDING', claimToken: 'worker-1' }]);
    });

    it('revert leaves another recipient\'s in-flight row to the worker, which cancels a failed retry', async () => {
      await routing().importFromEnv(actor);
      const other = await add('other@example.test', WARN);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const theirs = (await deliveries({ recipientId: other.id }))[0]!;
      await inFlight(theirs.id);

      const preview = await routing().previewRevert();
      expect(preview).toMatchObject({ counts: counts({ PENDING: { rebind: 1, cancel: 0 } }), inFlight: 1, blockers: [] });
      // Its retry would be cancelled: that needs the operator's confirmation too.
      expect((await errorOf(routing().applyRevert(actor, { token: preview.token, cancelUnmatched: false }))).code).toBe(
        'CONFIRM_CANCEL_REQUIRED',
      );
      await routing().applyRevert(actor, { token: preview.token, cancelUnmatched: true });
      expect(await deliveries({ id: theirs.id })).toMatchObject([
        { recipientId: other.id, status: 'SENDING', claimToken: 'worker-1' },
      ]);

      expect(await outcome(theirs.id, 'FAILED')).toBe(true);
      await worker().deliverDue();
      expect(await deliveries({ id: theirs.id })).toMatchObject([
        { recipientId: other.id, status: 'CANCELLED', errorCode: 'ROUTING_REVERTED' },
      ]);
      expect(alertMails().map((mail) => mail.to)).toEqual([OPS_EMAIL]);
    });

    it('revert: another recipient\'s in-flight send that lands stays SENT', async () => {
      await routing().importFromEnv(actor);
      const other = await add('other@example.test', WARN);
      await cutover();
      await warningAlert();
      await evaluator().evaluateOnly();
      const theirs = (await deliveries({ recipientId: other.id }))[0]!;
      await inFlight(theirs.id);
      await revert();

      expect(await outcome(theirs.id, 'SENT')).toBe(true);
      expect(await deliveries({ id: theirs.id })).toMatchObject([{ recipientId: other.id, status: 'SENT' }]);
    });
  });
});
