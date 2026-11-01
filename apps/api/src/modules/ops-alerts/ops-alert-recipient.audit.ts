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

/**
 * Stored only by ADDRESS_REPLACED, which writes two rows in one transaction:
 * the old recipient's row carries `replacedBy` (the new id), the new one's
 * `replaces` (the old id), so either side leads to the other. Ids only.
 */
export const REPLACEMENT_AUDIT_FIELDS = ['replaces', 'replacedBy'] as const;
export type RecipientReplacementLink = { replaces: string } | { replacedBy: string };

/**
 * ROUTING_CUTOVER / ROUTING_REVERTED rows (no recipient) store
 * `{ emailRouting }` before and `{ emailRouting, counts, told }` after. They
 * are read back as the mode on each side and the numbers, flattened to
 * `counts.<STATUS>.<rebind|cancel>` and `told` — numbers only.
 */
const ROUTING_ACTIONS: readonly OpsAlertRecipientAuditAction[] = [
  OpsAlertRecipientAuditAction.ROUTING_CUTOVER,
  OpsAlertRecipientAuditAction.ROUTING_REVERTED,
];
const ROUTING_COUNT_STATUSES = ['PENDING', 'FAILED', 'SENDING'] as const;
const ROUTING_COUNT_KINDS = ['rebind', 'cancel'] as const;

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
    /** ADDRESS_REPLACED only: the other recipient of the pair, stored in `after`. */
    link?: RecipientReplacementLink;
  },
): Promise<void> {
  const fields = input.fields ?? RECIPIENT_AUDIT_FIELDS;
  if (input.link && input.action !== OpsAlertRecipientAuditAction.ADDRESS_REPLACED) {
    throw new Error('A replacement link belongs to ADDRESS_REPLACED only.');
  }
  const link: Prisma.InputJsonObject =
    input.link && 'replaces' in input.link ? { replaces: input.link.replaces } : input.link ? { replacedBy: input.link.replacedBy } : {};
  await tx.opsAlertRecipientAuditLog.create({
    data: {
      recipientId: input.recipientId,
      actorId: input.actorId,
      action: input.action,
      before: input.before ? pick(input.before, fields) : Prisma.DbNull,
      after: input.after ? { ...pick(input.after, fields), ...link } : Prisma.DbNull,
      reason: input.reason ?? null,
    },
    select: { id: true },
  });
}

type RecipientAuditHost = { opsAlertRecipientAuditLog: Prisma.TransactionClient['opsAlertRecipientAuditLog'] };

function readSide(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Prisma.JsonValue>) : {};
}

const asNumber = (value: Prisma.JsonValue | undefined): number | null => (typeof value === 'number' ? value : null);
const asRouting = (value: Prisma.JsonValue | undefined): string | null =>
  value === 'ENV_LEGACY' || value === 'MANAGED' ? value : null;

/** A routing switch: the mode on each side, then the approved numbers, flattened — nothing else from the JSON. */
function routingChanges(before: Record<string, Prisma.JsonValue>, after: Record<string, Prisma.JsonValue>): AuditChange[] {
  const changes: AuditChange[] = [
    { field: 'emailRouting', from: asRouting(before.emailRouting), to: asRouting(after.emailRouting) },
  ];
  const counts = readSide(after.counts ?? null);
  for (const status of ROUTING_COUNT_STATUSES) {
    const cell = readSide(counts[status] ?? null);
    for (const kind of ROUTING_COUNT_KINDS) {
      changes.push({ field: `counts.${status}.${kind}`, from: null, to: asNumber(cell[kind]) });
    }
  }
  changes.push({ field: 'told', from: null, to: asNumber(after.told) });
  return changes;
}

/** The recipient-row fields an entry of this action may show. */
function projectedFields(action: OpsAlertRecipientAuditAction): readonly string[] {
  const base = [...RECIPIENT_AUDIT_FIELDS, ...ROTATION_AUDIT_FIELDS, ...TEST_AUDIT_FIELDS];
  return action === OpsAlertRecipientAuditAction.ADDRESS_REPLACED ? [...base, ...REPLACEMENT_AUDIT_FIELDS] : base;
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
    const routing = ROUTING_ACTIONS.includes(row.action);
    const changes: AuditChange[] = routing ? routingChanges(before, after) : [];
    for (const field of routing ? [] : projectedFields(row.action)) {
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
