import { Prisma } from '@prisma/client';
import { staffActorSelect } from '../modules/auth/embedded-permissions';
import type { AuthUser } from '../modules/auth/auth.types';
import {
  AdminAuditEntry,
  AdminAuditPage,
  AUDIT_ORDER,
  AuditPageQueryDto,
  auditPage,
  auditPaging,
  toAuditActor,
} from './admin-audit';

type AccountStatusHost = {
  accountStatusChange: Prisma.TransactionClient['accountStatusChange'];
};

/**
 * One account's AccountStatusChange rows as audit entries (ADMIN-ACTION-AUDIT-001).
 * Shared by the staff and the customer screens: the fact is one column on
 * User either way, and each caller has already established that the account
 * is of its own kind and that the viewer may read it.
 */
export async function readAccountStatusHistory(
  prisma: AccountStatusHost,
  userId: string,
  domain: 'STAFF_ACCOUNT' | 'CUSTOMER',
  query: AuditPageQueryDto | undefined,
  viewer: AuthUser,
): Promise<AdminAuditPage> {
  const { page, pageSize, skip } = auditPaging(query);
  const where = { userId } satisfies Prisma.AccountStatusChangeWhereInput;
  const [total, rows] = await Promise.all([
    prisma.accountStatusChange.count({ where }),
    prisma.accountStatusChange.findMany({
      where,
      orderBy: [...AUDIT_ORDER],
      skip,
      take: pageSize,
      select: {
        id: true,
        userId: true,
        fromActive: true,
        toActive: true,
        reason: true,
        createdAt: true,
        actor: staffActorSelect(viewer),
      },
    }),
  ]);

  const items = rows.map(
    (row): AdminAuditEntry => ({
      id: row.id,
      domain,
      action: row.toActive ? 'ACTIVATED' : 'DEACTIVATED',
      actor: toAuditActor(row.actor),
      target: { type: domain, id: row.userId },
      changes: [{ field: 'isActive', from: row.fromActive, to: row.toActive }],
      reason: row.reason,
      createdAt: row.createdAt,
    }),
  );
  return auditPage(items, total, page, pageSize);
}
