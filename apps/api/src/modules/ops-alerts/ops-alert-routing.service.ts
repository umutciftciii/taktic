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
import {
  LEGACY_AFTER_CUTOVER_ERROR_CODE,
  PREFERENCE_OFF_ERROR_CODE,
  ROUTING_REVERTED_ERROR_CODE,
} from './ops-alert-delivery.worker';
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
 *             PENDING/FAILED/SENDING on any alert, SENT only on OPEN alerts,
 *             where it carries "told" so that recipient gets the RESOLVED.
 *             Resolved alerts' sent history stays untouched (a SENDING row
 *             there is left to the worker, which binds it on a retry, and is
 *             counted under `inFlight`). A PENDING/FAILED row the recipient's
 *             preferences do not take (the worker's own rule: OPENED/REMINDER
 *             by the severity frozen in the snapshot, else the alert's;
 *             RESOLVED by recovery) is bound and cancelled (PREFERENCE_OFF) —
 *             the worker would cancel it on its next pass, and the preview
 *             shows it as a cancel so preview == effect. A SENDING one is only
 *             bound, claim kept, and counted as a rebind: its outcome write
 *             records SENT (and "told") or FAILED truthfully, and a retry is
 *             the worker's PREFERENCE_OFF cancel. Pending legacy rows with no
 *             matching ACTIVE recipient block the cutover.
 *   revert    rows of the recipient matching the env address (any status) are
 *             un-bound, so the env address keeps "told". Pending rows of
 *             every other recipient are cancelled (ROUTING_REVERTED) — only
 *             when the operator confirms the cancellation. A SENDING one is
 *             left as it is (`inFlight`, and it needs the same confirmation):
 *             its outcome is recorded truthfully, and in ENV_LEGACY the
 *             worker cancels a retry ROUTING_REVERTED.
 *
 * **A notice the far side already has a row for.** The two partial unique
 * keys allow one legacy row and one row per recipient for each notice, so
 * the row a switch moves (cutover: legacy; revert: the match's) cannot move
 * when the env address's recipient (cutover) or the env address (revert)
 * already has a row for that notice — its partner, the same mailbox. Rows
 * cannot trade keys (the indexes are not deferrable), and a CANCELLED or
 * ABANDONED row is final, so the partner's status decides:
 *
 *   moving \ partner     PENDING/FAILED   SENDING   SENT     CANCELLED/ABANDONED
 *   PENDING/FAILED       cancel           wait      cancel   wait
 *   SENDING              wait             wait      inFlight wait
 *   SENT                 wait             wait      —        —
 *
 *   cancel    the moving row is a duplicate: the partner delivers, or has
 *             (LEGACY_AFTER_CUTOVER / ROUTING_REVERTED)
 *   inFlight  left untouched with its claim; the partner was sent, so a retry
 *             is cancelled by the worker in the new mode
 *   wait      the ROUTING_COLLISION_PENDING blocker: cancelling either row
 *             could lose the notice (the partner is dead, or in flight and
 *             not yet routed) or send it twice (one copy went, the other is
 *             still due). It clears on its own: the worker settles the rows
 *             in the current mode — it delivers the only live copy, or drops
 *             the duplicate of a sent one — and resolving the alert cancels
 *             what never went out. Counted under `collisions`.
 *   —         settled on both sides; nothing moves (the row stays bound, or
 *             legacy, where it is)
 *
 * Partner rows are locked FOR UPDATE with the moving rows, so the worker
 * cannot claim either side between the plan and the writes.
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
export { ROUTING_REVERTED_ERROR_CODE };
const TOKEN_DOMAIN = 'ops-alert-routing-preview:v2:';

export type RoutingBlocker =
  | 'NO_LIVE_CRITICAL_CHANNEL'
  | 'LEGACY_ROWS_UNMATCHED'
  | 'ROUTING_COLLISION_PENDING'
  | 'ALREADY_IN_MODE';
export type RoutingDirection = 'CUTOVER' | 'REVERT';
type PendingStatus = 'PENDING' | 'FAILED' | 'SENDING';
const PENDING_STATUSES: readonly PendingStatus[] = ['PENDING', 'FAILED', 'SENDING'];

/**
 * Rows the switch rebinds or cancels, by status. A switch never cancels a
 * SENDING row: `SENDING.cancel` is only ever the cutover's unmatched in-flight
 * rows, shown as what would be lost while LEGACY_ROWS_UNMATCHED blocks it.
 */
export type RoutingCounts = Record<PendingStatus, { rebind: number; cancel: number }>;

export type RoutingPreview = {
  direction: RoutingDirection;
  counts: RoutingCounts;
  /**
   * SENT rows whose "told" moves with the switch (cutover: OPEN alerts only).
   * A SENDING row is in flight and is counted under `counts.SENDING`, not here.
   */
  told: number;
  /**
   * SENDING rows the switch leaves untouched, claim and all, for the worker:
   * the cutover's on a resolved alert or beside a SENT row of the recipient;
   * the revert's of other recipients or beside a SENT legacy row.
   */
  inFlight: number;
  /** Notices held by ROUTING_COLLISION_PENDING: one per pair of rows the switch waits for. */
  collisions: number;
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
type PlanRow = {
  id: string;
  status: OpsAlertDeliveryStatus;
  matched: boolean;
  /** The status of the far side's row for the same notice, or null when there is none. */
  partnerStatus: OpsAlertDeliveryStatus | null;
  open: boolean;
};
type CutoverRow = PlanRow & { kind: OpsAlertNoticeKind; noticeSnapshot: unknown; severity: OpsAlertSeverity };
type PairOutcome = 'cancel' | 'inFlight' | 'wait' | 'keep';

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
  inFlight: number;
  /** Revert only: the part of `inFlight` that is other recipients' rows, whose retry the worker cancels. */
  othersInFlight: number;
  collisions: number;
  blockers: RoutingBlocker[];
};

const isPending = (status: OpsAlertDeliveryStatus): status is PendingStatus =>
  (PENDING_STATUSES as readonly string[]).includes(status);

/** The table in the header comment: what a switch does with a row whose notice the far side has. */
function pairOutcome(moving: OpsAlertDeliveryStatus, partner: OpsAlertDeliveryStatus): PairOutcome {
  const sent = partner === OpsAlertDeliveryStatus.SENT;
  const queued = partner === OpsAlertDeliveryStatus.PENDING || partner === OpsAlertDeliveryStatus.FAILED;
  const live = queued || partner === OpsAlertDeliveryStatus.SENDING;
  switch (moving) {
    case OpsAlertDeliveryStatus.PENDING:
    case OpsAlertDeliveryStatus.FAILED:
      return queued || sent ? 'cancel' : 'wait';
    case OpsAlertDeliveryStatus.SENDING:
      return sent ? 'inFlight' : 'wait';
    case OpsAlertDeliveryStatus.SENT:
      return live ? 'wait' : 'keep';
    default:
      return 'keep';
  }
}

function emptyPlan(direction: RoutingDirection, emailRouting: OpsAlertEmailRouting, matchId: string | null): Plan {
  return {
    direction,
    emailRouting,
    matchId,
    rebindIds: [],
    cancelIds: [],
    preferenceOffIds: [],
    counts: emptyCounts(),
    told: 0,
    inFlight: 0,
    othersInFlight: 0,
    collisions: 0,
    blockers: [],
  };
}

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

function previewToken(plan: Pick<Plan, 'direction' | 'counts' | 'told' | 'inFlight' | 'collisions' | 'emailRouting'>): string {
  const body = canonicalJson({
    counts: plan.counts,
    told: plan.told,
    inFlight: plan.inFlight,
    collisions: plan.collisions,
    emailRouting: plan.emailRouting,
  });
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
      // Another recipient's in-flight row is cancelled by the worker if it fails: the same confirmation.
      if ((plan.cancelIds.length > 0 || plan.othersInFlight > 0) && input.cancelUnmatched !== true) {
        throw new ConfirmCancelRequiredError();
      }
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
      inFlight: plan.inFlight,
      collisions: plan.collisions,
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
    // The partners — the match's own rows for a notice that has a legacy row — first.
    if (lock && matchId !== null) {
      await client.$queryRaw`
        SELECT m."id" FROM "OpsAlertDelivery" m
        WHERE m."recipientId" = ${matchId}
          AND EXISTS (
            SELECT 1 FROM "OpsAlertDelivery" l
            WHERE l."alertId" = m."alertId" AND l."kind" = m."kind" AND l."sequence" = m."sequence"
              AND l."channel" = 'EMAIL' AND l."recipientId" IS NULL
          )
        ORDER BY m."id"
        FOR UPDATE`;
    }
    const rows = await client.$queryRaw<CutoverRow[]>`
      SELECT d."id", d."status", d."kind", d."noticeSnapshot", a."severity",
        FALSE AS "matched", (a."state" = 'OPEN') AS "open",
        (
          SELECT m."status" FROM "OpsAlertDelivery" m
          WHERE m."alertId" = d."alertId" AND m."kind" = d."kind" AND m."sequence" = d."sequence"
            AND m."recipientId" = ${matchId}
        ) AS "partnerStatus"
      FROM "OpsAlertDelivery" d
      JOIN "OpsAlert" a ON a."id" = d."alertId"
      WHERE d."channel" = 'EMAIL' AND d."recipientId" IS NULL
        AND d."status" IN ('PENDING', 'FAILED', 'SENDING', 'SENT')
      ORDER BY d."id"
      ${lock ? Prisma.sql`FOR UPDATE OF d` : Prisma.empty}`;

    const plan = emptyPlan('CUTOVER', emailRouting, matchId);
    let unmatchedPending = 0;
    for (const row of rows) {
      const pending = isPending(row.status);
      const sending = row.status === OpsAlertDeliveryStatus.SENDING;
      if (matchId === null) {
        // Shown as what would be lost; the blocker below keeps it from happening.
        // A resolved alert's history is not counted, but an unmatched SENDING
        // row there would still be cancelled by the worker on a retry.
        if (pending) unmatchedPending += 1;
        if (pending && (row.open || !sending)) plan.counts[row.status as PendingStatus].cancel += 1;
        continue;
      }
      if (row.partnerStatus !== null) {
        this.applyPair(plan, row, pairOutcome(row.status, row.partnerStatus));
      } else if (!row.open && (sending || row.status === OpsAlertDeliveryStatus.SENT)) {
        // A resolved alert's history is not rewritten; an in-flight row there
        // is bound by the worker if it is retried.
        if (sending) plan.inFlight += 1;
      } else if (
        row.status !== OpsAlertDeliveryStatus.SENDING &&
        pending &&
        prefs &&
        !recipientWants(row.kind, readNoticeSnapshot(row.noticeSnapshot)?.severity ?? row.severity, prefs)
      ) {
        // The worker would cancel it on its next pass; the preview says so now.
        plan.counts[row.status as PendingStatus].cancel += 1;
        plan.preferenceOffIds.push(row.id);
      } else {
        // An in-flight row is bound whatever the preferences: its outcome is
        // the worker's to write, and a retry meets the worker's own rule.
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
    if (plan.collisions > 0) plan.blockers.push('ROUTING_COLLISION_PENDING');
    return plan;
  }

  private async planRevert(client: Client, lock: boolean): Promise<Plan> {
    const emailRouting = await this.mode(client);
    const matchId = await this.matchingRecipient(client, false);
    // The partners — legacy rows for a notice the match has a row for — first.
    if (lock && matchId !== null) {
      await client.$queryRaw`
        SELECT l."id" FROM "OpsAlertDelivery" l
        WHERE l."channel" = 'EMAIL' AND l."recipientId" IS NULL
          AND EXISTS (
            SELECT 1 FROM "OpsAlertDelivery" m
            WHERE m."alertId" = l."alertId" AND m."kind" = l."kind" AND m."sequence" = l."sequence"
              AND m."recipientId" = ${matchId}
          )
        ORDER BY l."id"
        FOR UPDATE`;
    }
    // `partnerStatus`: a legacy row for this notice exists, so un-binding would break its unique key.
    const rows = await client.$queryRaw<PlanRow[]>`
      SELECT d."id", d."status",
        COALESCE(d."recipientId" = ${matchId}, FALSE) AS "matched",
        TRUE AS "open",
        (
          SELECT l."status" FROM "OpsAlertDelivery" l
          WHERE l."alertId" = d."alertId" AND l."kind" = d."kind" AND l."sequence" = d."sequence"
            AND l."channel" = d."channel" AND l."recipientId" IS NULL
        ) AS "partnerStatus"
      FROM "OpsAlertDelivery" d
      WHERE d."recipientId" IS NOT NULL
        AND (COALESCE(d."recipientId" = ${matchId}, FALSE) OR d."status" IN ('PENDING', 'FAILED', 'SENDING'))
      ORDER BY d."id"
      ${lock ? Prisma.sql`FOR UPDATE OF d` : Prisma.empty}`;

    const plan = emptyPlan('REVERT', emailRouting, matchId);
    for (const row of rows) {
      const pending = isPending(row.status);
      if (row.matched && row.partnerStatus !== null) {
        this.applyPair(plan, row, pairOutcome(row.status, row.partnerStatus));
      } else if (row.matched) {
        // Any status: the env address keeps what it was told, and gets what is pending.
        plan.rebindIds.push(row.id);
        if (pending) plan.counts[row.status as PendingStatus].rebind += 1;
        else if (row.status === OpsAlertDeliveryStatus.SENT) plan.told += 1;
      } else if (row.status === OpsAlertDeliveryStatus.SENDING) {
        // Another recipient's send in flight: its outcome is recorded; a retry, cancelled by the worker.
        plan.inFlight += 1;
        plan.othersInFlight += 1;
      } else if (pending) {
        plan.counts[row.status as PendingStatus].cancel += 1;
        plan.cancelIds.push(row.id);
      }
    }

    if (emailRouting === OpsAlertEmailRouting.ENV_LEGACY) plan.blockers.push('ALREADY_IN_MODE');
    // ENV_LEGACY's critical channels are the env address and Telegram.
    const config = readOpsAlertConfigSafely();
    if (config.email === null && config.telegram === null) plan.blockers.push('NO_LIVE_CRITICAL_CHANNEL');
    if (plan.collisions > 0) plan.blockers.push('ROUTING_COLLISION_PENDING');
    return plan;
  }

  /** One moving row whose notice the far side already has, by {@link pairOutcome}. */
  private applyPair(plan: Plan, row: PlanRow, outcome: PairOutcome): void {
    if (outcome === 'cancel') {
      plan.counts[row.status as PendingStatus].cancel += 1;
      plan.cancelIds.push(row.id);
    } else if (outcome === 'inFlight') {
      plan.inFlight += 1;
    } else if (outcome === 'wait') {
      plan.collisions += 1;
    }
    // 'keep': settled on both sides; the row stays where it is.
  }

  /** Writes only the link column; status, claim, attempts and timestamps stay. */
  private async bind(tx: Client, ids: string[], recipientId: string | null): Promise<void> {
    if (ids.length === 0) return;
    await tx.opsAlertDelivery.updateMany({ where: { id: { in: ids } }, data: { recipientId } });
  }

  /**
   * Final, no send. Only PENDING/FAILED rows come here — a SENDING row is never
   * cancelled by a switch (its worker's outcome write would find no claim and
   * a sent letter would read as CANCELLED) — and they hold no claim.
   */
  private async cancel(tx: Client, ids: string[], errorCode: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.opsAlertDelivery.updateMany({
      where: { id: { in: ids } },
      data: { status: OpsAlertDeliveryStatus.CANCELLED, errorCode },
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
        after: { emailRouting, counts: plan.counts, told: plan.told, inFlight: plan.inFlight },
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
