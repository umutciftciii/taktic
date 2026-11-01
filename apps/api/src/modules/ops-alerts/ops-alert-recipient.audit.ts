import { OpsAlertRecipientAuditAction, Prisma } from '@prisma/client';
import { staffActorSelect } from '../auth/embedded-permissions';
import type { AuthUser } from '../auth/auth.types';
import {
  AdminAuditEntry,
  AdminAuditPage,
  AUDIT_ORDER,
  AuditChange,
  AuditPageQueryDto,
  auditPage,
  auditPaging,
  toAuditActor,
} from '../../common/admin-audit';

/**
 * OBS-ALERT-002 — the recipient change log (OpsAlertRecipientAuditLog).
 *
 * `before` / `after` hold only the allow-listed fields below: never the
 * address, its ciphertext or its HMAC. Only fields that differ are stored, so
 * a row reads as exactly what that action changed. A create has `before`
 * NULL.
 */

export const RECIPIENT_AUDIT_FIELDS = [
  'label',
  'notifyWarning',
  'notifyCritical',
  'notifyRecovery',
  'status',
  'maskedAddress',
] as const;

/**
 * Stored only by REWRAPPED / REHASHED: which key sealed the address, which
 * version of the identity key hashed it. Metadata, never the ciphertext or
 * the HMAC itself.
 */
export const ROTATION_AUDIT_FIELDS = ['keyId', 'hmacVersion'] as const;

/**
 * Stored only by TEST_SENT: the closed result code of the test send (`SENT`,
 * a NotificationErrorCode or DECRYPT_FAILED). Never the address or a message.
 */
export const TEST_AUDIT_FIELDS = ['result'] as const;

export type RecipientAuditField = (typeof RECIPIENT_AUDIT_FIELDS)[number];
export type RecipientAuditSnapshot = {
  label: string;
  notifyWarning: boolean;
  notifyCritical: boolean;
  notifyRecovery: boolean;
  status: string;
  maskedAddress: string;
};

/** The audited values of a recipient row. An explicit pick, so no other column can leak in. */
export function recipientAuditSnapshot(row: RecipientAuditSnapshot): RecipientAuditSnapshot {
  return {
    label: row.label,
    notifyWarning: row.notifyWarning,
    notifyCritical: row.notifyCritical,
    notifyRecovery: row.notifyRecovery,
    status: row.status,
    maskedAddress: row.maskedAddress,
  };
}

function pick(
  snapshot: RecipientAuditSnapshot,
  fields: readonly RecipientAuditField[],
): Prisma.InputJsonObject {
  const out: Record<string, string | boolean> = {};
  for (const field of fields) out[field] = snapshot[field];
  return out;
}

/** The allow-listed fields whose value differs, in allowlist order. */
export function changedRecipientFields(
  before: RecipientAuditSnapshot,
  after: RecipientAuditSnapshot,
): RecipientAuditField[] {
  return RECIPIENT_AUDIT_FIELDS.filter((field) => before[field] !== after[field]);
}

/** One REWRAPPED / REHASHED row: `{ keyId }` or `{ hmacVersion }` on each side, nothing else. */
export async function recordRotationAudit(
  tx: Prisma.TransactionClient,
  input:
    | { recipientId: string; actorId: string; action: 'REWRAPPED'; before: { keyId: string }; after: { keyId: string } }
    | { recipientId: string; actorId: string; action: 'REHASHED'; before: { hmacVersion: number }; after: { hmacVersion: number } },
): Promise<void> {
  await tx.opsAlertRecipientAuditLog.create({
    data: {
      recipientId: input.recipientId,
      actorId: input.actorId,
      action: input.action,
      before: { ...input.before },
      after: { ...input.after },
    },
    select: { id: true },
  });
}

/**
 * One TEST_SENT row: `after` is `{ result }`, nothing else. The id is the
 * caller's, because the test e-mail's idempotency key names it before the
 * row is written.
 */
export async function recordTestAudit(
  tx: Prisma.TransactionClient,
  input: { id: string; recipientId: string; actorId: string; result: string },
): Promise<void> {
  await tx.opsAlertRecipientAuditLog.create({
    data: {
      id: input.id,
      recipientId: input.recipientId,
      actorId: input.actorId,
      action: OpsAlertRecipientAuditAction.TEST_SENT,
      before: Prisma.DbNull,
      after: { result: input.result },
    },
    select: { id: true },
  });
}

export async function recordRecipientAudit(
  tx: Prisma.TransactionClient,
  input: {
    recipientId: string | null;
    actorId: string;
    action: OpsAlertRecipientAuditAction;
    /** NULL for a create. */
    before?: RecipientAuditSnapshot | null;
    after?: RecipientAuditSnapshot | null;
    /** Restricts the stored fields to these (a diff); every allow-listed field when omitted. */
    fields?: readonly RecipientAuditField[];
    reason?: string | null;
  },
): Promise<void> {
  const fields = input.fields ?? RECIPIENT_AUDIT_FIELDS;
  await tx.opsAlertRecipientAuditLog.create({
    data: {
      recipientId: input.recipientId,
      actorId: input.actorId,
      action: input.action,
      before: input.before ? pick(input.before, fields) : Prisma.DbNull,
      after: input.after ? pick(input.after, fields) : Prisma.DbNull,
      reason: input.reason ?? null,
    },
    select: { id: true },
  });
}

type RecipientAuditHost = { opsAlertRecipientAuditLog: Prisma.TransactionClient['opsAlertRecipientAuditLog'] };

function readSide(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Prisma.JsonValue>) : {};
}

/** One recipient's history, or every recipient's and the routing events' when `recipientId` is null. */
export async function readRecipientAudit(
  prisma: RecipientAuditHost,
  recipientId: string | null,
  query: AuditPageQueryDto | undefined,
  viewer?: AuthUser,
): Promise<AdminAuditPage> {
  const { page, pageSize, skip } = auditPaging(query);
  const where: Prisma.OpsAlertRecipientAuditLogWhereInput = recipientId === null ? {} : { recipientId };
  const [total, rows] = await Promise.all([
    prisma.opsAlertRecipientAuditLog.count({ where }),
    prisma.opsAlertRecipientAuditLog.findMany({
      where,
      orderBy: [...AUDIT_ORDER],
      skip,
      take: pageSize,
      select: {
        id: true,
        recipientId: true,
        action: true,
        before: true,
        after: true,
        reason: true,
        createdAt: true,
        actor: staffActorSelect(viewer),
      },
    }),
  ]);
  const items = rows.map((row): AdminAuditEntry => {
    const before = readSide(row.before);
    const after = readSide(row.after);
    const changes: AuditChange[] = [];
    for (const field of [...RECIPIENT_AUDIT_FIELDS, ...ROTATION_AUDIT_FIELDS, ...TEST_AUDIT_FIELDS]) {
      if (!(field in before) && !(field in after)) continue;
      changes.push({
        field,
        from: (before[field] ?? null) as AuditChange['from'],
        to: (after[field] ?? null) as AuditChange['to'],
      });
    }
    return {
      id: row.id,
      domain: 'OPS_ALERT_RECIPIENT',
      action: row.action,
      actor: toAuditActor(row.actor),
      target: row.recipientId ? { type: 'OPS_ALERT_RECIPIENT', id: row.recipientId } : null,
      changes,
      reason: row.reason,
      createdAt: row.createdAt,
    };
  });
  return auditPage(items, total, page, pageSize);
}
