import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OpsAlertDeliveryStatus, OpsAlertRecipientAuditAction, OpsAlertRecipientStatus, Prisma } from '@prisma/client';
import type { AdminAuditPage, AuditPageQueryDto } from '../../common/admin-audit';
import type { AuthUser } from '../auth/auth.types';
import { maskEmail } from '../notifications/mask';
import { PrismaService } from '../../prisma/prisma.service';
import { OPS_ALERT_RECIPIENT_LIMIT, OPS_ALERT_RECIPIENT_LOCK_KEY, OPS_ALERT_ROUTING_ID } from './ops-alert-recipient.constants';
import {
  RecipientAuditSnapshot,
  changedRecipientFields,
  readRecipientAudit,
  recipientAuditSnapshot,
  recordRecipientAudit,
} from './ops-alert-recipient.audit';
import { readAppEnvironment } from '../../common/app-environment';
import { readOpsAlertConfigSafely } from './ops-alert.config';
import { decideRecipientRemoval } from './ops-alert-recipient-guard';
import { addressHmac, decryptAddress, encryptAddress, normalizeAddress } from './recipient-crypto';
import { RecipientCryptoConfig, resolveRecipientCryptoConfig } from './recipient-crypto.config';

/**
 * OBS-ALERT-002 — admin-managed operations-alert e-mail recipients.
 *
 * Every mutation runs in one READ COMMITTED transaction that first takes
 * `pg_advisory_xact_lock(OPS_ALERT_RECIPIENT_LOCK_KEY)` — the lock the limit
 * trigger takes too — so edits, the live count and a racing create are
 * serialised, and writes its audit row in that same transaction. The trigger
 * and the live-HMAC unique index are the backstops; their refusals are mapped
 * to the same errors as the service's own checks.
 *
 * The address is sealed under the recipient's id (AAD), so the id is
 * generated here, before the insert. HTTP mapping of the errors below is the
 * controller's job; each carries a stable `code`.
 */

/** Error codes, as the API contract names them. */
export class RecipientLimitReachedError extends Error {
  readonly code = 'RECIPIENT_LIMIT';
  override name = 'RecipientLimitReachedError';
  constructor() {
    super(`At most ${OPS_ALERT_RECIPIENT_LIMIT} alert recipients can be live at once.`);
  }
}

export class DuplicateRecipientError extends Error {
  readonly code = 'RECIPIENT_DUPLICATE';
  override name = 'DuplicateRecipientError';
  constructor() {
    super('That address is already an alert recipient.');
  }
}

export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';
  override name = 'VersionConflictError';
  constructor() {
    super('The recipient was changed by someone else; reload and try again.');
  }
}

export class LastCriticalConfirmationRequired extends Error {
  readonly code = 'LAST_CRITICAL_CONFIRM_REQUIRED';
  override name = 'LastCriticalConfirmationRequired';
  constructor() {
    super('This is the last recipient of critical alert e-mails; confirm to continue.');
  }
}

export class LastChannelProtectedError extends Error {
  readonly code = 'LAST_CHANNEL_PROTECTED';
  override name = 'LastChannelProtectedError';
  constructor() {
    super('This is the last active alert channel in production and cannot be removed.');
  }
}

export class RecipientDeletedError extends Error {
  readonly code = 'RECIPIENT_DELETED';
  override name = 'RecipientDeletedError';
  constructor() {
    super('The recipient has been deleted.');
  }
}

export type RecipientView = {
  id: string;
  label: string;
  maskedAddress: string;
  notifyWarning: boolean;
  notifyCritical: boolean;
  notifyRecovery: boolean;
  status: OpsAlertRecipientStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastSentAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  keyId: string | null;
  isLastCritical: boolean;
};

export type CreateRecipientInput = {
  address: string;
  label: string;
  notifyWarning: boolean;
  notifyCritical: boolean;
  notifyRecovery: boolean;
};

export type UpdateRecipientInput = {
  version: number;
  label?: string;
  notifyWarning?: boolean;
  notifyCritical?: boolean;
  notifyRecovery?: boolean;
  /** Accepted; evaluated by the last-channel guard (OBS-ALERT-002 A4). */
  confirmLastCritical?: boolean;
};

const MAX_LABEL_LENGTH = 80;
/** Set on a pending delivery whose recipient was removed, so it is never sent. */
export const RECIPIENT_REMOVED_ERROR_CODE = 'RECIPIENT_REMOVED';
const LIMIT_MESSAGE_PREFIX = 'ops_alert_recipient_limit:';

const RECIPIENT_SELECT = {
  id: true,
  label: true,
  maskedAddress: true,
  notifyWarning: true,
  notifyCritical: true,
  notifyRecovery: true,
  status: true,
  version: true,
  addressKeyId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OpsAlertRecipientSelect;

type RecipientRow = Prisma.OpsAlertRecipientGetPayload<{ select: typeof RECIPIENT_SELECT }>;

/** A new id for a recipient; random, as the schema's cuid would be, but known before the insert. */
function newRecipientId(): string {
  return `c${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
}

function cleanLabel(raw: string): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label.length < 1 || label.length > MAX_LABEL_LENGTH) {
    throw new BadRequestException(`The label must be 1 to ${MAX_LABEL_LENGTH} characters.`);
  }
  return label;
}

/**
 * The limit trigger's refusal: SQLSTATE 23514 (check_violation) and the
 * message prefix. Prisma drops the constraint name and, for a RAISE inside an
 * interactive transaction, throws PrismaClientUnknownRequestError with no
 * `code`/`meta`; the SQLSTATE survives only inside the message text
 * (`PostgresError { code: "23514", message: "ops_alert_recipient_limit: ..." }`).
 * A raw-query error carries it as `meta.code`. Either way both facts are
 * required, so another check violation is never mistaken for the limit.
 */
function isLimitRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.includes(LIMIT_MESSAGE_PREFIX)) return false;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  return meta?.code === '23514' || error.message.includes('code: "23514"') || error.message.includes('SQLSTATE 23514');
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    return meta?.code === '23505';
  }
  return false;
}

/** The database's refusals, as the service's own errors. Anything else is returned untouched. */
export function mapDatabaseError(error: unknown): unknown {
  if (isLimitRefusal(error)) return new RecipientLimitReachedError();
  if (isUniqueViolation(error)) return new DuplicateRecipientError();
  return error;
}

@Injectable()
export class OpsAlertRecipientsService {
  private cryptoConfig: RecipientCryptoConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private crypto(): RecipientCryptoConfig {
    this.cryptoConfig ??= resolveRecipientCryptoConfig();
    return this.cryptoConfig;
  }

  /** Runs `work` in one transaction under the recipient lock, mapping the database's refusals. */
  private async locked<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPS_ALERT_RECIPIENT_LOCK_KEY}::bigint)`;
        return work(tx);
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async list(): Promise<RecipientView[]> {
    const rows = await this.prisma.opsAlertRecipient.findMany({
      where: { status: { not: OpsAlertRecipientStatus.DELETED } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: RECIPIENT_SELECT,
    });
    return this.toViews(this.prisma, rows);
  }

  async create(actor: AuthUser, input: CreateRecipientInput): Promise<RecipientView> {
    const label = cleanLabel(input.label);
    const normalized = normalizeAddress(input.address);
    return this.locked(async (tx) => {
      const row = await this.insertRecipient(tx, actor, {
        normalized,
        label,
        notifyWarning: input.notifyWarning,
        notifyCritical: input.notifyCritical,
        notifyRecovery: input.notifyRecovery,
        status: OpsAlertRecipientStatus.ACTIVE,
      });
      await recordRecipientAudit(tx, {
        recipientId: row.id,
        actorId: actor.id,
        action: OpsAlertRecipientAuditAction.CREATED,
        before: null,
        after: recipientAuditSnapshot(row),
      });
      return (await this.toViews(tx, [row]))[0]!;
    });
  }

  async update(actor: AuthUser, id: string, input: UpdateRecipientInput): Promise<RecipientView> {
    const label = input.label === undefined ? undefined : cleanLabel(input.label);
    return this.locked(async (tx) => {
      const before = await this.loadLive(tx, id, input.version);
      const data: Prisma.OpsAlertRecipientUpdateManyMutationInput = {};
      if (label !== undefined) data.label = label;
      if (input.notifyWarning !== undefined) data.notifyWarning = input.notifyWarning;
      if (input.notifyCritical !== undefined) data.notifyCritical = input.notifyCritical;
      if (input.notifyRecovery !== undefined) data.notifyRecovery = input.notifyRecovery;
      const wanted: RecipientAuditSnapshot = { ...recipientAuditSnapshot(before), ...(data as Partial<RecipientAuditSnapshot>) };
      const changed = changedRecipientFields(recipientAuditSnapshot(before), wanted);
      if (changed.length === 0) return (await this.toViews(tx, [before]))[0]!;
      if (before.status === OpsAlertRecipientStatus.ACTIVE && before.notifyCritical && data.notifyCritical === false) {
        await this.guardLastCritical(tx, before.id, input.confirmLastCritical === true);
      }

      const after = await this.bump(tx, actor, before, data);
      const beforeSnap = recipientAuditSnapshot(before);
      const afterSnap = recipientAuditSnapshot(after);
      if (changed.includes('label')) {
        await recordRecipientAudit(tx, {
          recipientId: id,
          actorId: actor.id,
          action: OpsAlertRecipientAuditAction.LABEL_CHANGED,
          before: beforeSnap,
          after: afterSnap,
          fields: ['label'],
        });
      }
      const prefFields = changed.filter((field) => field !== 'label');
      if (prefFields.length > 0) {
        await recordRecipientAudit(tx, {
          recipientId: id,
          actorId: actor.id,
          action: OpsAlertRecipientAuditAction.PREFERENCES_CHANGED,
          before: beforeSnap,
          after: afterSnap,
          fields: prefFields,
        });
      }
      return (await this.toViews(tx, [after]))[0]!;
    });
  }

  async pause(actor: AuthUser, id: string, input: { version: number; confirmLastCritical?: boolean }): Promise<RecipientView> {
    return this.setStatus(
      actor,
      id,
      input.version,
      OpsAlertRecipientStatus.PAUSED,
      OpsAlertRecipientAuditAction.PAUSED,
      input.confirmLastCritical === true,
    );
  }

  async resume(actor: AuthUser, id: string, input: { version: number }): Promise<RecipientView> {
    return this.setStatus(actor, id, input.version, OpsAlertRecipientStatus.ACTIVE, OpsAlertRecipientAuditAction.RESUMED);
  }

  async remove(
    actor: AuthUser,
    id: string,
    input: { version: number; reason: string; confirmLastCritical?: boolean },
  ): Promise<void> {
    await this.locked(async (tx) => {
      const before = await this.loadLive(tx, id, input.version);
      if (before.status === OpsAlertRecipientStatus.ACTIVE && before.notifyCritical) {
        await this.guardLastCritical(tx, before.id, input.confirmLastCritical === true);
      }
      await this.shred(tx, actor, before, OpsAlertRecipientAuditAction.DELETED, input.reason);
    });
  }

  async replaceAddress(
    actor: AuthUser,
    id: string,
    input: { version: number; address: string; reason: string },
  ): Promise<RecipientView> {
    const normalized = normalizeAddress(input.address);
    return this.locked(async (tx) => {
      const old = await this.loadLive(tx, id, input.version);
      // The old recipient goes first: its slot and its HMAC are free for the
      // new one, so replacing a recipient at the limit, or by the very same
      // address, is not refused.
      await this.shred(tx, actor, old, OpsAlertRecipientAuditAction.ADDRESS_REPLACED, input.reason);
      const row = await this.insertRecipient(tx, actor, {
        normalized,
        label: old.label,
        notifyWarning: old.notifyWarning,
        notifyCritical: old.notifyCritical,
        notifyRecovery: old.notifyRecovery,
        status: old.status,
      });
      await recordRecipientAudit(tx, {
        recipientId: row.id,
        actorId: actor.id,
        action: OpsAlertRecipientAuditAction.ADDRESS_REPLACED,
        before: null,
        after: recipientAuditSnapshot(row),
        reason: input.reason,
      });
      return (await this.toViews(tx, [row]))[0]!;
    });
  }

  async reveal(actor: AuthUser, id: string): Promise<{ address: string }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.opsAlertRecipient.findUnique({
        where: { id },
        select: {
          status: true,
          addressCiphertext: true,
          addressNonce: true,
          addressTag: true,
          addressKeyId: true,
        },
      });
      if (!row) throw new NotFoundException('Recipient not found.');
      if (
        row.status === OpsAlertRecipientStatus.DELETED ||
        !row.addressCiphertext ||
        !row.addressNonce ||
        !row.addressTag ||
        !row.addressKeyId
      ) {
        throw new RecipientDeletedError();
      }
      const address = decryptAddress(this.crypto(), id, {
        ciphertext: Buffer.from(row.addressCiphertext),
        nonce: Buffer.from(row.addressNonce),
        tag: Buffer.from(row.addressTag),
        keyId: row.addressKeyId,
      });
      await recordRecipientAudit(tx, { recipientId: id, actorId: actor.id, action: OpsAlertRecipientAuditAction.REVEALED });
      return { address };
    });
  }

  auditPage(id: string | null, query: AuditPageQueryDto, viewer?: AuthUser): Promise<AdminAuditPage> {
    return readRecipientAudit(this.prisma, id, query, viewer);
  }

  // -------------------------------------------------------------------------

  private async setStatus(
    actor: AuthUser,
    id: string,
    version: number,
    status: OpsAlertRecipientStatus,
    action: OpsAlertRecipientAuditAction,
    confirmLastCritical = false,
  ): Promise<RecipientView> {
    return this.locked(async (tx) => {
      const before = await this.loadLive(tx, id, version);
      if (before.status === status) return (await this.toViews(tx, [before]))[0]!;
      if (
        status === OpsAlertRecipientStatus.PAUSED &&
        before.status === OpsAlertRecipientStatus.ACTIVE &&
        before.notifyCritical
      ) {
        await this.guardLastCritical(tx, before.id, confirmLastCritical);
      }
      const after = await this.bump(tx, actor, before, { status });
      await recordRecipientAudit(tx, {
        recipientId: id,
        actorId: actor.id,
        action,
        before: recipientAuditSnapshot(before),
        after: recipientAuditSnapshot(after),
        fields: ['status'],
      });
      return (await this.toViews(tx, [after]))[0]!;
    });
  }

  /**
   * The last-critical / last-channel guard for an operation that takes the
   * ACTIVE ∧ critical recipient `removedId` out of the critical set. Call under
   * the lock, before any write: the count and the routing row are then stable.
   * Environment and Telegram status are read now, never cached.
   */
  private async guardLastCritical(tx: Prisma.TransactionClient, removedId: string, confirmed: boolean): Promise<void> {
    const liveCriticalAfter = await tx.opsAlertRecipient.count({
      where: { status: OpsAlertRecipientStatus.ACTIVE, notifyCritical: true, id: { not: removedId } },
    });
    const settings = await tx.opsAlertRoutingSettings.findUnique({
      where: { id: OPS_ALERT_ROUTING_ID },
      select: { emailRouting: true },
    });
    const decision = decideRecipientRemoval({
      environment: readAppEnvironment(),
      telegramConfigured: readOpsAlertConfigSafely().telegram !== null,
      routing: settings?.emailRouting ?? 'ENV_LEGACY',
      liveCriticalAfter,
      touchesCritical: true,
      confirmed,
    });
    if (decision === 'BLOCKED') throw new LastChannelProtectedError();
    if (decision === 'CONFIRM_REQUIRED') throw new LastCriticalConfirmationRequired();
  }

  /** The row, refusing a missing one, a deleted one and a stale `version`. Call under the lock. */
  private async loadLive(tx: Prisma.TransactionClient, id: string, version: number): Promise<RecipientRow> {
    const row = await tx.opsAlertRecipient.findUnique({ where: { id }, select: RECIPIENT_SELECT });
    if (!row) throw new NotFoundException('Recipient not found.');
    if (row.status === OpsAlertRecipientStatus.DELETED) throw new RecipientDeletedError();
    if (row.version !== version) throw new VersionConflictError();
    return row;
  }

  /** Applies `data` and bumps the version, only if the version still matches. */
  private async bump(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    before: RecipientRow,
    data: Prisma.OpsAlertRecipientUpdateManyMutationInput,
  ): Promise<RecipientRow> {
    const result = await tx.opsAlertRecipient.updateMany({
      where: { id: before.id, version: before.version, status: { not: OpsAlertRecipientStatus.DELETED } },
      data: { ...data, version: { increment: 1 }, updatedById: actor.id },
    });
    if (result.count !== 1) throw new VersionConflictError();
    return tx.opsAlertRecipient.findUniqueOrThrow({ where: { id: before.id }, select: RECIPIENT_SELECT });
  }

  /** Soft delete with crypto-shred, and cancel what was still waiting to be sent to it. */
  private async shred(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    before: RecipientRow,
    action: OpsAlertRecipientAuditAction,
    reason: string,
  ): Promise<void> {
    const result = await tx.opsAlertRecipient.updateMany({
      where: { id: before.id, version: before.version, status: { not: OpsAlertRecipientStatus.DELETED } },
      data: {
        status: OpsAlertRecipientStatus.DELETED,
        addressCiphertext: null,
        addressNonce: null,
        addressTag: null,
        addressKeyId: null,
        addressHmac: null,
        addressHmacVersion: null,
        deletedAt: new Date(),
        deletedById: actor.id,
        updatedById: actor.id,
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new VersionConflictError();
    // SENDING rows are the worker's: it re-checks the recipient at send time.
    await tx.opsAlertDelivery.updateMany({
      where: {
        recipientId: before.id,
        status: { in: [OpsAlertDeliveryStatus.PENDING, OpsAlertDeliveryStatus.FAILED] },
      },
      data: { status: OpsAlertDeliveryStatus.CANCELLED, errorCode: RECIPIENT_REMOVED_ERROR_CODE },
    });
    await recordRecipientAudit(tx, {
      recipientId: before.id,
      actorId: actor.id,
      action,
      before: recipientAuditSnapshot(before),
      after: { ...recipientAuditSnapshot(before), status: OpsAlertRecipientStatus.DELETED },
      fields: ['status'],
      reason,
    });
  }

  /** Counts, seals and inserts one recipient. Call under the lock. */
  private async insertRecipient(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    input: {
      normalized: string;
      label: string;
      notifyWarning: boolean;
      notifyCritical: boolean;
      notifyRecovery: boolean;
      status: OpsAlertRecipientStatus;
    },
  ): Promise<RecipientRow> {
    const live = await tx.opsAlertRecipient.count({ where: { status: { not: OpsAlertRecipientStatus.DELETED } } });
    if (live >= OPS_ALERT_RECIPIENT_LIMIT) throw new RecipientLimitReachedError();

    const config = this.crypto();
    const id = newRecipientId();
    const sealed = encryptAddress(config, id, input.normalized);
    const identity = addressHmac(config, input.normalized);
    return tx.opsAlertRecipient.create({
      data: {
        id,
        label: input.label,
        addressCiphertext: new Uint8Array(sealed.ciphertext),
        addressNonce: new Uint8Array(sealed.nonce),
        addressTag: new Uint8Array(sealed.tag),
        addressKeyId: sealed.keyId,
        addressHmac: identity.hmac,
        addressHmacVersion: identity.version,
        maskedAddress: maskEmail(input.normalized),
        notifyWarning: input.notifyWarning,
        notifyCritical: input.notifyCritical,
        notifyRecovery: input.notifyRecovery,
        status: input.status,
        createdById: actor.id,
        updatedById: actor.id,
      },
      select: RECIPIENT_SELECT,
    });
  }

  /** Views of `rows`, with delivery facts and the last-critical flag derived from the database. */
  private async toViews(
    client: Pick<Prisma.TransactionClient, 'opsAlertDelivery' | 'opsAlertRecipient'>,
    rows: RecipientRow[],
  ): Promise<RecipientView[]> {
    const critical = await client.opsAlertRecipient.findMany({
      where: { status: OpsAlertRecipientStatus.ACTIVE, notifyCritical: true },
      select: { id: true },
      take: 2,
    });
    const lastCriticalId = critical.length === 1 ? critical[0]!.id : null;

    const views: RecipientView[] = [];
    for (const row of rows) {
      const lastSent = await client.opsAlertDelivery.findFirst({
        where: { recipientId: row.id, status: OpsAlertDeliveryStatus.SENT },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { sentAt: true, createdAt: true },
      });
      const failureWhere: Prisma.OpsAlertDeliveryWhereInput = {
        recipientId: row.id,
        status: { in: [OpsAlertDeliveryStatus.FAILED, OpsAlertDeliveryStatus.ABANDONED] },
        ...(lastSent ? { createdAt: { gt: lastSent.createdAt } } : {}),
      };
      const [consecutiveFailures, lastFailure] = await Promise.all([
        client.opsAlertDelivery.count({ where: failureWhere }),
        client.opsAlertDelivery.findFirst({
          where: failureWhere,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { errorCode: true },
        }),
      ]);
      views.push({
        id: row.id,
        label: row.label,
        maskedAddress: row.maskedAddress,
        notifyWarning: row.notifyWarning,
        notifyCritical: row.notifyCritical,
        notifyRecovery: row.notifyRecovery,
        status: row.status,
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastSentAt: (lastSent?.sentAt ?? lastSent?.createdAt)?.toISOString() ?? null,
        lastErrorCode: lastFailure?.errorCode ?? null,
        consecutiveFailures,
        keyId: row.addressKeyId,
        isLastCritical: row.id === lastCriticalId,
      });
    }
    return views;
  }
}
