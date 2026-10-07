import { Prisma, SeoAuditAction, SeoAuditEntity } from '@prisma/client';
import { staffActorSelect } from '../auth/embedded-permissions';
import type { AuthUser } from '../auth/auth.types';
import {
  AdminAuditDomain,
  AdminAuditEntry,
  AdminAuditPage,
  AUDIT_ORDER,
  AuditChange,
  AuditPageQueryDto,
  AuditValue,
  auditPage,
  auditPaging,
  diffAuditFields,
  readAuditChanges,
  toAuditActor,
  toAuditJson,
} from '../../common/admin-audit';

/**
 * SEO-004 — the audit of redirect and 404-suggestion writes (SeoAuditLog),
 * read through the shared admin audit contract like every other domain.
 *
 * Written inside the transaction of the write it describes, by the operator
 * who made it. A redirect a slug change creates, retargets or reclaims is
 * written under the operator who changed the slug; the slug itself is audited
 * with the category (CatalogAuditLog).
 */

export const SEO_REDIRECT_AUDIT_FIELDS = ['sourcePath', 'targetPath', 'type', 'active', 'origin', 'reason'] as const;
export const SEO_NOT_FOUND_AUDIT_FIELDS = ['status', 'redirect'] as const;

const DOMAIN: Record<SeoAuditEntity, AdminAuditDomain> = {
  REDIRECT: 'SEO_REDIRECT',
  NOT_FOUND_PATH: 'SEO_NOT_FOUND_PATH',
};

export type SeoRedirectAuditRow = {
  sourcePath: string;
  targetPath: string;
  type: string;
  active: boolean;
  origin: string;
  reason: string | null;
};

export function redirectAuditSnapshot(row: SeoRedirectAuditRow): Record<string, AuditValue> {
  return {
    sourcePath: row.sourcePath,
    targetPath: row.targetPath,
    type: row.type,
    active: row.active,
    origin: row.origin,
    reason: row.reason,
  };
}

export async function recordSeoAudit(
  tx: Prisma.TransactionClient,
  input: {
    entityType: SeoAuditEntity;
    entityId: string;
    action: SeoAuditAction;
    changes: AuditChange[];
    reason?: string | null;
    actorId: string;
  },
): Promise<void> {
  await tx.seoAuditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      changes: toAuditJson(input.changes),
      reason: input.reason ?? null,
      actorId: input.actorId,
    },
    select: { id: true },
  });
}

/** A redirect row's audit entry, diffed from its before/after rows. */
export async function recordRedirectAudit(
  tx: Prisma.TransactionClient,
  input: {
    redirectId: string;
    action: SeoAuditAction;
    before: SeoRedirectAuditRow | null;
    after: SeoRedirectAuditRow;
    reason?: string | null;
    actorId: string;
  },
): Promise<void> {
  await recordSeoAudit(tx, {
    entityType: SeoAuditEntity.REDIRECT,
    entityId: input.redirectId,
    action: input.action,
    changes: diffAuditFields(
      input.before ? redirectAuditSnapshot(input.before) : null,
      redirectAuditSnapshot(input.after),
      SEO_REDIRECT_AUDIT_FIELDS,
    ),
    reason: input.reason,
    actorId: input.actorId,
  });
}

type SeoAuditHost = { seoAuditLog: Prisma.TransactionClient['seoAuditLog'] };

/** One record's SEO history, newest first. The caller has checked the record and the permission. */
export async function readSeoAudit(
  prisma: SeoAuditHost,
  entityType: SeoAuditEntity,
  entityId: string,
  query: AuditPageQueryDto | undefined,
  viewer: AuthUser,
): Promise<AdminAuditPage> {
  const { page, pageSize, skip } = auditPaging(query);
  const where = { entityType, entityId } satisfies Prisma.SeoAuditLogWhereInput;
  const [total, rows] = await Promise.all([
    prisma.seoAuditLog.count({ where }),
    prisma.seoAuditLog.findMany({
      where,
      orderBy: [...AUDIT_ORDER],
      skip,
      take: pageSize,
      select: {
        id: true,
        action: true,
        changes: true,
        reason: true,
        createdAt: true,
        actor: staffActorSelect(viewer),
      },
    }),
  ]);
  const domain = DOMAIN[entityType];
  const items = rows.map(
    (row): AdminAuditEntry => ({
      id: row.id,
      domain,
      action: row.action,
      actor: toAuditActor(row.actor),
      target: { type: domain, id: entityId },
      changes: readAuditChanges(row.changes),
      reason: row.reason,
      createdAt: row.createdAt,
    }),
  );
  return auditPage(items, total, page, pageSize);
}
