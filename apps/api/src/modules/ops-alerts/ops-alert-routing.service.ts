import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertEmailRouting,
  OpsAlertNoticeKind,
  OpsAlertRecipientAuditAction,
  OpsAlertRecipientStatus,
  OpsAlertSeverity,
  Prisma,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { readOpsAlertConfigSafely } from './ops-alert.config';
import { OPS_ALERT_ADVISORY_LOCK_KEY, readNoticeSnapshot, recipientWants } from './ops-alert.rules';
import { LEGACY_AFTER_CUTOVER_ERROR_CODE, PREFERENCE_OFF_ERROR_CODE } from './ops-alert-delivery.worker';
import { OPS_ALERT_RECIPIENT_LOCK_KEY, OPS_ALERT_ROUTING_ID } from './ops-alert-recipient.constants';
import { OpsAlertRecipientsService, type RecipientView } from './ops-alert-recipients.service';
import { addressHmac, normalizeAddress } from './recipient-crypto';
import { resolveRecipientCryptoConfig } from './recipient-crypto.config';

/**
 * OBS-ALERT-002 — switching alert e-mail between OPS_ALERT_EMAIL (ENV_LEGACY)
 * and the managed recipients (MANAGED), and back, without losing a notice or
 * sending one to a different mailbox.
 *
 * **The bridge is the env address's identity.** A legacy row (no recipient)
 * carries no address: it was meant for OPS_ALERT_EMAIL. The recipient whose
 * HMAC is the env address's is that same mailbox, so only that recipient may
 * take legacy rows over, and only its rows may go back to being legacy.
 *
 *   cutover   legacy e-mail rows get the matching ACTIVE recipient's id —
 *             only the link column changes (a SENDING row keeps its claim):
 *             PENDING/FAILED on any alert, SENDING/SENT only on OPEN alerts,
 *             where they carry "told" so that recipient gets the RESOLVED.
 *             Resolved alerts' sent history stays untouched (a SENDING row
 *             there is left to the worker, which binds it on a retry). When
 *             the recipient already has its own row
 *             for that notice, the legacy row is cancelled instead
 *             (LEGACY_AFTER_CUTOVER; a SENT one is left as it is). A pending
 *             row the recipient's preferences do not take (the worker's own
 *             rule: OPENED/REMINDER by the severity frozen in the snapshot,
 *             else the alert's; RESOLVED by recovery) is bound and cancelled
 *             (PREFERENCE_OFF) — the worker would cancel it on its next pass,
 *             and the preview shows it as a cancel so preview == effect.
 *             Pending legacy rows with no matching ACTIVE recipient block the
 *             cutover.
 *   revert    rows of the recipient matching the env address (any status) are
 *             un-bound, so the env address keeps "told". Where a legacy row
 *             for that notice already exists, the pending managed row is
 *             cancelled and a settled one stays bound. Pending rows of every
 *             other recipient are cancelled (ROUTING_REVERTED) — only when the
 *             operator confirms the cancellation.
 *
 * **Previews bind the approval to the numbers.** A preview's token is an HMAC
 * (the recipient HMAC key) over the direction, the per-status counts, "told"
 * and the mode it saw. The apply recomputes all of it inside its transaction,
 * under the locks, and refuses with COUNTS_CHANGED if anything moved; the
 * client cannot mint a token.
 *
 * **Locks.** Every apply is one transaction that takes, blocking and in this
 * order, `pg_advisory_xact_lock(OPS_ALERT_ADVISORY_LOCK_KEY)` (the evaluator's
 * lock: no notice is queued halfway through a switch; a tick that meets it
 * reports BUSY) and then `pg_advisory_xact_lock(OPS_ALERT_RECIPIENT_LOCK_KEY)`
 * (no recipient changes under it). The evaluator takes only the first and the
 * recipient service only the second, so the fixed order cannot deadlock;
 * anything that ever needs both must take them in this order. The rows the
 * apply touches are locked FOR UPDATE, so the delivery worker — which takes
 * neither advisory lock — skips them when claiming and its outcome write
 * waits for the commit.
 *
 * HTTP mapping of the errors below is the controller's job; each carries a
 * stable `code`.
 */

export const IMPORTED_RECIPIENT_LABEL = 'OPS_ALERT_EMAIL (içe aktarıldı)';
export const ROUTING_REVERTED_ERROR_CODE = 'ROUTING_REVERTED';
const TOKEN_DOMAIN = 'ops-alert-routing-preview:v1:';

export type RoutingBlocker = 'NO_LIVE_CRITICAL_CHANNEL' | 'LEGACY_ROWS_UNMATCHED' | 'ALREADY_IN_MODE';
export type RoutingDirection = 'CUTOVER' | 'REVERT';
type PendingStatus = 'PENDING' | 'FAILED' | 'SENDING';
const PENDING_STATUSES: readonly PendingStatus[] = ['PENDING', 'FAILED', 'SENDING'];

export type RoutingCounts = Record<PendingStatus, { rebind: number; cancel: number }>;

export type RoutingPreview = {
  direction: RoutingDirection;
  counts: RoutingCounts;
  /**
   * SENT rows whose "told" moves with the switch (cutover: OPEN alerts only).
   * A SENDING row is in flight and is counted under `counts.SENDING`, not here.
   */
  told: number;
  blockers: RoutingBlocker[];
  token: string;
};

export type RoutingState = {
  emailRouting: OpsAlertEmailRouting;
  changedAt: Date | null;
  envAddressConfigured: boolean;
  /** The env address is a live (not deleted) managed recipient: importing it again is a duplicate. */
  envAddressManaged: boolean;
  activeRecipients: number;
  liveCritical: number;
  telegramConfigured: boolean;
  /** Live recipients per encryption key id. */
  keyIds: Record<string, number>;
  /** Live recipients per HMAC key version. */
  hmacVersions: Record<string, number>;
};

export class EnvAddressMissingError extends Error {
  readonly code = 'ENV_ADDRESS_MISSING';
  override name = 'EnvAddressMissingError';
  constructor() {
    super('OPS_ALERT_EMAIL is not set; there is no address to import.');
  }
}

export class RoutingCountsChangedError extends Error {
  readonly code = 'COUNTS_CHANGED';
  override name = 'RoutingCountsChangedError';
  constructor() {
    super('The deliveries changed since the preview; preview again.');
  }
}

export class ConfirmCancelRequiredError extends Error {
  readonly code = 'CONFIRM_CANCEL_REQUIRED';
  override name = 'ConfirmCancelRequiredError';
  constructor() {
    super('Going back cancels pending deliveries; confirm the cancellation.');
  }
}

export class RoutingBlockedError extends Error {
  readonly code: RoutingBlocker;
  override name = 'RoutingBlockedError';
  constructor(readonly blockers: RoutingBlocker[]) {
    super(`The routing switch is blocked (${blockers.join(', ')}).`);
    this.code = blockers[0]!;
  }
}

type Client = Prisma.TransactionClient;
type PlanRow = { id: string; status: OpsAlertDeliveryStatus; matched: boolean; collides: boolean; open: boolean };
type CutoverRow = PlanRow & { kind: OpsAlertNoticeKind; noticeSnapshot: unknown; severity: OpsAlertSeverity };

/** What one switch would do, row by row, and the numbers the operator approves. */
type Plan = {
  direction: RoutingDirection;
  emailRouting: OpsAlertEmailRouting;
  /** The recipient on the far side of the bridge, or none. */
  matchId: string | null;
  rebindIds: string[];
  cancelIds: string[];
  /** Cutover only: rows bound to the match and cancelled PREFERENCE_OFF. Counted under `cancel`. */
  preferenceOffIds: string[];
  counts: RoutingCounts;
  told: number;
  blockers: RoutingBlocker[];
};

const isPending = (status: OpsAlertDeliveryStatus): status is PendingStatus =>
  (PENDING_STATUSES as readonly string[]).includes(status);

function emptyCounts(): RoutingCounts {
  return { PENDING: { rebind: 0, cancel: 0 }, FAILED: { rebind: 0, cancel: 0 }, SENDING: { rebind: 0, cancel: 0 } };
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function previewToken(plan: Pick<Plan, 'direction' | 'counts' | 'told' | 'emailRouting'>): string {
  const body = canonicalJson({ counts: plan.counts, told: plan.told, emailRouting: plan.emailRouting });
  return createHmac('sha256', resolveRecipientCryptoConfig().hmacKey)
    .update(TOKEN_DOMAIN + plan.direction + body, 'utf8')
    .digest('hex');
}

/** Constant-time; anything that is not 64 lowercase hex characters is simply a mismatch. */
function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

/** The env address's identity, or null when it is unset or not a plain address. */
function envIdentity(): { hmac: string; version: number } | null {
  const email = readOpsAlertConfigSafely().email;
  if (!email) return null;
  let normalized: string;
  try {
    normalized = normalizeAddress(email);
  } catch {
    return null;
  }
  return addressHmac(resolveRecipientCryptoConfig(), normalized);
}

@Injectable()
export class OpsAlertRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipients: OpsAlertRecipientsService,
  ) {}

  state(): Promise<RoutingState> {
    return this.readState(this.prisma);
  }

  /** OPS_ALERT_EMAIL as a managed recipient, every preference on; one IMPORTED_FROM_ENV audit row. */
  async importFromEnv(actor: AuthUser): Promise<RecipientView> {
    const email = readOpsAlertConfigSafely().email;
    if (!email) throw new EnvAddressMissingError();
    return this.recipients.create(
      actor,
      { address: email, label: IMPORTED_RECIPIENT_LABEL, notifyWarning: true, notifyCritical: true, notifyRecovery: true },
      OpsAlertRecipientAuditAction.IMPORTED_FROM_ENV,
    );
  }

  async previewCutover(): Promise<RoutingPreview> {
    return this.toPreview(await this.planCutover(this.prisma, false));
  }

  async previewRevert(): Promise<RoutingPreview> {
    return this.toPreview(await this.planRevert(this.prisma, false));
  }

  async applyCutover(actor: AuthUser, input: { token: string }): Promise<RoutingState> {
    return this.locked(async (tx) => {
      const plan = await this.planCutover(tx, true);
      this.approve(plan, input.token);
      await this.bind(tx, [...plan.rebindIds, ...plan.preferenceOffIds], plan.matchId);
      await this.cancel(tx, plan.cancelIds, LEGACY_AFTER_CUTOVER_ERROR_CODE);
      await this.cancel(tx, plan.preferenceOffIds, PREFERENCE_OFF_ERROR_CODE);
      return this.switchMode(tx, actor, plan, OpsAlertEmailRouting.MANAGED, OpsAlertRecipientAuditAction.ROUTING_CUTOVER);
    });
  }

  async applyRevert(actor: AuthUser, input: { token: string; cancelUnmatched: boolean }): Promise<RoutingState> {
    return this.locked(async (tx) => {
      const plan = await this.planRevert(tx, true);
      this.approve(plan, input.token);
      if (plan.cancelIds.length > 0 && input.cancelUnmatched !== true) throw new ConfirmCancelRequiredError();
      await this.bind(tx, plan.rebindIds, null);
      await this.cancel(tx, plan.cancelIds, ROUTING_REVERTED_ERROR_CODE);
      return this.switchMode(tx, actor, plan, OpsAlertEmailRouting.ENV_LEGACY, OpsAlertRecipientAuditAction.ROUTING_REVERTED);
    });
  }

  // -------------------------------------------------------------------------

  /** One transaction holding the evaluator lock, then the recipient lock — always in this order. */
  private locked<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPS_ALERT_ADVISORY_LOCK_KEY}::bigint)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPS_ALERT_RECIPIENT_LOCK_KEY}::bigint)`;
        return work(tx);
      },
      // The evaluator's own transaction may hold the lock for up to 20 s.
      { timeout: 45_000, maxWait: 5_000 },
    );
  }

  /** Blockers first (they say why), then the numbers the operator approved. */
  private approve(plan: Plan, token: string): void {
    if (plan.blockers.length > 0) throw new RoutingBlockedError(plan.blockers);
    if (!tokenMatches(previewToken(plan), token)) throw new RoutingCountsChangedError();
  }

  private toPreview(plan: Plan): RoutingPreview {
    return {
      direction: plan.direction,
      counts: plan.counts,
      told: plan.told,
      blockers: plan.blockers,
      token: previewToken(plan),
    };
  }

  private async mode(client: Client): Promise<OpsAlertEmailRouting> {
    const settings = await client.opsAlertRoutingSettings.findUnique({
      where: { id: OPS_ALERT_ROUTING_ID },
      select: { emailRouting: true },
    });
    return settings?.emailRouting ?? OpsAlertEmailRouting.ENV_LEGACY;
  }

  /** The recipient that is the env address: ACTIVE only (cutover), or any live one (revert). */
  private async matchingRecipient(client: Client, activeOnly: boolean): Promise<string | null> {
    const identity = envIdentity();
    if (!identity) return null;
    const match = await client.opsAlertRecipient.findFirst({
      where: {
        status: activeOnly ? OpsAlertRecipientStatus.ACTIVE : { not: OpsAlertRecipientStatus.DELETED },
        channel: OpsAlertChannel.EMAIL,
        addressHmac: identity.hmac,
        addressHmacVersion: identity.version,
      },
      select: { id: true },
    });
    return match?.id ?? null;
  }

  private async planCutover(client: Client, lock: boolean): Promise<Plan> {
    const emailRouting = await this.mode(client);
    const matchId = await this.matchingRecipient(client, true);
    // The match's preferences decide, like the worker, whether a row it takes over would be sent.
    const prefs = matchId
      ? await client.opsAlertRecipient.findUnique({
          where: { id: matchId },
          select: { notifyWarning: true, notifyCritical: true, notifyRecovery: true },
        })
      : null;
    // `collides`: the recipient already has its own row for this notice.
    const rows = await client.$queryRaw<CutoverRow[]>`
      SELECT d."id", d."status", d."kind", d."noticeSnapshot", a."severity",
        FALSE AS "matched", (a."state" = 'OPEN') AS "open",
        EXISTS (
          SELECT 1 FROM "OpsAlertDelivery" m
          WHERE m."alertId" = d."alertId" AND m."kind" = d."kind" AND m."sequence" = d."sequence"
            AND m."recipientId" = ${matchId}
        ) AS "collides"
      FROM "OpsAlertDelivery" d
      JOIN "OpsAlert" a ON a."id" = d."alertId"
      WHERE d."channel" = 'EMAIL' AND d."recipientId" IS NULL
        AND d."status" IN ('PENDING', 'FAILED', 'SENDING', 'SENT')
      ORDER BY d."id"
      ${lock ? Prisma.sql`FOR UPDATE OF d` : Prisma.empty}`;

    const plan: Plan = {
      direction: 'CUTOVER',
      emailRouting,
      matchId,
      rebindIds: [],
      cancelIds: [],
      preferenceOffIds: [],
      counts: emptyCounts(),
      told: 0,
      blockers: [],
    };
    let unmatchedPending = 0;
    for (const row of rows) {
      const pending = isPending(row.status);
      // SENT and in-flight SENDING rows are history the recipient was (being) told;
      // on a resolved alert they are left alone.
      const settledOrInFlight = row.status === OpsAlertDeliveryStatus.SENT || row.status === OpsAlertDeliveryStatus.SENDING;
      if (settledOrInFlight && !row.open) {
        // A resolved alert's history is not rewritten. An unmatched SENDING row
        // there would still be cancelled by the worker on a retry, so it blocks.
        if (matchId === null && pending) unmatchedPending += 1;
        continue;
      }
      if (matchId === null) {
        // Shown as what would be lost; the blocker below keeps it from happening.
        if (pending) {
          plan.counts[row.status as PendingStatus].cancel += 1;
          unmatchedPending += 1;
        }
      } else if (row.collides) {
        if (pending) {
          plan.counts[row.status as PendingStatus].cancel += 1;
          plan.cancelIds.push(row.id);
        }
        // A SENT legacy row beside the recipient's own row stays as it is.
      } else if (pending && prefs && !recipientWants(row.kind, readNoticeSnapshot(row.noticeSnapshot)?.severity ?? row.severity, prefs)) {
        // The worker would cancel it on its next pass; the preview says so now.
        plan.counts[row.status as PendingStatus].cancel += 1;
        plan.preferenceOffIds.push(row.id);
      } else {
        plan.rebindIds.push(row.id);
        if (pending) plan.counts[row.status as PendingStatus].rebind += 1;
        if (row.status === OpsAlertDeliveryStatus.SENT) plan.told += 1;
      }
    }

    if (emailRouting === OpsAlertEmailRouting.MANAGED) plan.blockers.push('ALREADY_IN_MODE');
    const liveCritical = await client.opsAlertRecipient.count({
      where: { status: OpsAlertRecipientStatus.ACTIVE, notifyCritical: true },
    });
    if (liveCritical === 0 && readOpsAlertConfigSafely().telegram === null) plan.blockers.push('NO_LIVE_CRITICAL_CHANNEL');
    if (unmatchedPending > 0) plan.blockers.push('LEGACY_ROWS_UNMATCHED');
    return plan;
  }

  private async planRevert(client: Client, lock: boolean): Promise<Plan> {
    const emailRouting = await this.mode(client);
    const matchId = await this.matchingRecipient(client, false);
    // `collides`: a legacy row for this notice exists, so un-binding would break its unique key.
    const rows = await client.$queryRaw<PlanRow[]>`
      SELECT d."id", d."status",
        COALESCE(d."recipientId" = ${matchId}, FALSE) AS "matched",
        EXISTS (
          SELECT 1 FROM "OpsAlertDelivery" l
          WHERE l."alertId" = d."alertId" AND l."kind" = d."kind" AND l."sequence" = d."sequence"
            AND l."channel" = d."channel" AND l."recipientId" IS NULL
        ) AS "collides"
      FROM "OpsAlertDelivery" d
      WHERE d."recipientId" IS NOT NULL
        AND (COALESCE(d."recipientId" = ${matchId}, FALSE) OR d."status" IN ('PENDING', 'FAILED', 'SENDING'))
      ORDER BY d."id"
      ${lock ? Prisma.sql`FOR UPDATE OF d` : Prisma.empty}`;

    const plan: Plan = {
      direction: 'REVERT',
      emailRouting,
      matchId,
      rebindIds: [],
      cancelIds: [],
      preferenceOffIds: [],
      counts: emptyCounts(),
      told: 0,
      blockers: [],
    };
    for (const row of rows) {
      const pending = isPending(row.status);
      if (row.matched && !row.collides) {
        // Any status: the env address keeps what it was told, and gets what is pending.
        plan.rebindIds.push(row.id);
        if (pending) plan.counts[row.status as PendingStatus].rebind += 1;
        else if (row.status === OpsAlertDeliveryStatus.SENT) plan.told += 1;
      } else if (pending) {
        // Another recipient's pending row, or the match's duplicate of a legacy row.
        plan.counts[row.status as PendingStatus].cancel += 1;
        plan.cancelIds.push(row.id);
      }
      // A settled row that collides stays bound to its recipient.
    }

    if (emailRouting === OpsAlertEmailRouting.ENV_LEGACY) plan.blockers.push('ALREADY_IN_MODE');
    // ENV_LEGACY's critical channels are the env address and Telegram.
    const config = readOpsAlertConfigSafely();
    if (config.email === null && config.telegram === null) plan.blockers.push('NO_LIVE_CRITICAL_CHANNEL');
    return plan;
  }

  /** Writes only the link column; status, claim, attempts and timestamps stay. */
  private async bind(tx: Client, ids: string[], recipientId: string | null): Promise<void> {
    if (ids.length === 0) return;
    await tx.opsAlertDelivery.updateMany({ where: { id: { in: ids } }, data: { recipientId } });
  }

  /** Final, no send. A SENDING row loses its claim, so the worker's outcome write finds nothing to update. */
  private async cancel(tx: Client, ids: string[], errorCode: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.opsAlertDelivery.updateMany({
      where: { id: { in: ids } },
      data: { status: OpsAlertDeliveryStatus.CANCELLED, errorCode, claimToken: null, claimedAt: null },
    });
  }

  private async switchMode(
    tx: Client,
    actor: AuthUser,
    plan: Plan,
    emailRouting: OpsAlertEmailRouting,
    action: typeof OpsAlertRecipientAuditAction.ROUTING_CUTOVER | typeof OpsAlertRecipientAuditAction.ROUTING_REVERTED,
  ): Promise<RoutingState> {
    const changedAt = new Date();
    await tx.opsAlertRoutingSettings.upsert({
      where: { id: OPS_ALERT_ROUTING_ID },
      create: { id: OPS_ALERT_ROUTING_ID, emailRouting, changedAt, changedById: actor.id },
      update: { emailRouting, changedAt, changedById: actor.id },
    });
    await tx.opsAlertRecipientAuditLog.create({
      data: {
        recipientId: null,
        actorId: actor.id,
        action,
        before: { emailRouting: plan.emailRouting },
        after: { emailRouting, counts: plan.counts, told: plan.told },
      },
      select: { id: true },
    });
    return this.readState(tx);
  }

  private async readState(client: Client): Promise<RoutingState> {
    const config = readOpsAlertConfigSafely();
    const settings = await client.opsAlertRoutingSettings.findUnique({
      where: { id: OPS_ALERT_ROUTING_ID },
      select: { emailRouting: true, changedAt: true },
    });
    const live = { status: { not: OpsAlertRecipientStatus.DELETED } } satisfies Prisma.OpsAlertRecipientWhereInput;
    const [envAddressManaged, activeRecipients, liveCritical, byKey, byVersion] = await Promise.all([
      this.matchingRecipient(client, false).then((id) => id !== null),
      client.opsAlertRecipient.count({ where: { status: OpsAlertRecipientStatus.ACTIVE } }),
      client.opsAlertRecipient.count({ where: { status: OpsAlertRecipientStatus.ACTIVE, notifyCritical: true } }),
      client.opsAlertRecipient.groupBy({ by: ['addressKeyId'], where: live, _count: { _all: true } }),
      client.opsAlertRecipient.groupBy({ by: ['addressHmacVersion'], where: live, _count: { _all: true } }),
    ]);
    const keyIds: Record<string, number> = {};
    for (const row of byKey) if (row.addressKeyId !== null) keyIds[row.addressKeyId] = row._count._all;
    const hmacVersions: Record<string, number> = {};
    for (const row of byVersion) if (row.addressHmacVersion !== null) hmacVersions[String(row.addressHmacVersion)] = row._count._all;
    return {
      emailRouting: settings?.emailRouting ?? OpsAlertEmailRouting.ENV_LEGACY,
      changedAt: settings?.changedAt ?? null,
      envAddressConfigured: config.email !== null,
      envAddressManaged,
      activeRecipients,
      liveCritical,
      telegramConfigured: config.telegram !== null,
      keyIds,
      hmacVersions,
    };
  }
}
