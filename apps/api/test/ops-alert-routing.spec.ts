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
      expect(audit[0]!.after).toEqual({ emailRouting: 'MANAGED', counts: preview.counts, told: 0 });
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
      expect(preview.told).toBe(1);
      await routing().applyCutover(actor, { token: preview.token });

      expect(await deliveries({ id: legacy!.id })).toMatchObject([
        { recipientId: imported.id, status: 'SENDING', claimToken: 'worker-1', claimedAt, attemptCount: 1 },
      ]);
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
      const email = await deliveries({ channel: 'EMAIL' });
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
      expect(audit[0]!.after).toEqual({ emailRouting: 'ENV_LEGACY', counts: preview.counts, told: 0 });

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
});
