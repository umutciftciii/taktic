import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Prisma } from '@prisma/client';

/**
 * ADMIN-ACTION-AUDIT-001 — the one read shape every admin audit trail is
 * projected into.
 *
 * The rows live in their own domain tables (AdminRoleAuditLog,
 * AccountStatusChange, ProviderStatusChange, CompanySettingsChange,
 * CatalogAuditLog), each holding exactly the facts its domain has. This file is
 * where they meet: one entry shape, one diff primitive and one page shape, so
 * every "Neler oldu" on the admin panel reads the same contract and draws it
 * with the same component.
 *
 * Nothing here invents a value. `actor` is the stored actor or `null`; a
 * change's `from` is the database value before the save, `null` only when
 * there was none; `reason` is what the request carried, or `null`.
 */

export type AdminAuditDomain =
  | 'ADMIN_ROLE'
  | 'STAFF_ACCOUNT'
  | 'CUSTOMER'
  | 'PROVIDER'
  | 'COMPANY_SETTINGS'
  | 'CATEGORY'
  | 'CREDIT_PACKAGE'
  | 'SHOWCASE_PACKAGE';

/** A reference to another record, with the name it had when the row was written. */
export type AuditRef = { id: string; name: string | null };

/** A recorded value: a scalar, a reference, a set of references, or a set of codes. */
export type AuditValue = string | number | boolean | null | AuditRef | AuditRef[] | string[];

export type AuditChange = { field: string; from: AuditValue; to: AuditValue };

/**
 * Who did it. `email` follows `staffActorSelect`: present only when the viewer
 * holds ADMIN_USERS_READ, absent (not null) otherwise.
 */
export type AuditActor = { id: string; name: string | null; email?: string | null };

export type AdminAuditEntry = {
  id: string;
  domain: AdminAuditDomain;
  action: string;
  actor: AuditActor | null;
  target: { type: AdminAuditDomain; id: string; label?: string | null } | null;
  changes: AuditChange[];
  reason: string | null;
  createdAt: Date;
  /**
   * A free-text note the change carried, exactly as written with it (a
   * provider's moderation note). Not a field diff: the row does not know what
   * the note said before, so it is never shown as "from → to".
   */
  note?: string | null;
  /**
   * The account a role row is about (an assignment granted or revoked), when
   * the row names one. Role domain only.
   */
  targetUser?: AuditActor | null;
  /**
   * The row's own structural record, verbatim, where the source table keeps a
   * summary rather than a before/after pair (AdminRoleAuditLog.summary: a role
   * key, the permissions added and removed, the names of the fields an edit
   * touched). Shown as recorded; never reconstructed into values it lacks.
   */
  payload?: Prisma.JsonObject;
};

export type AdminAuditPage = {
  items: AdminAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export const AUDIT_DEFAULT_PAGE_SIZE = 20;
export const AUDIT_MAX_PAGE_SIZE = 50;

function toIntOrPass(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (!/^-?\d+$/.test(trimmed)) return value;
    return Number.parseInt(trimmed, 10);
  }
  return value;
}

/** `?page=&pageSize=` for every audit read. Out-of-range values are a 400. */
export class AuditPageQueryDto {
  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toIntOrPass(value))
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_PAGE_SIZE)
  pageSize?: number;
}

export function auditPaging(query: AuditPageQueryDto | undefined): { page: number; pageSize: number; skip: number } {
  const page = query?.page ?? 1;
  const pageSize = query?.pageSize ?? AUDIT_DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function auditPage(items: AdminAuditEntry[], total: number, page: number, pageSize: number): AdminAuditPage {
  return { items, total, page, pageSize, hasNextPage: page * pageSize < total };
}

/** Newest first, ties broken by id so a page boundary never repeats or skips a row. */
export const AUDIT_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const satisfies readonly {
  createdAt?: Prisma.SortOrder;
  id?: Prisma.SortOrder;
}[];

/** The stored actor as the entry shape; `email` only when the select carried it. */
export function toAuditActor(
  actor: { id: string; name: string | null; email?: string | null } | null | undefined,
): AuditActor | null {
  if (!actor) return null;
  return 'email' in actor && actor.email !== undefined
    ? { id: actor.id, name: actor.name, email: actor.email }
    : { id: actor.id, name: actor.name };
}

function sameValue(a: AuditValue, b: AuditValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return setKey(a) === setKey(b);
  }
  if (typeof a === 'object' && typeof b === 'object') return a.id === b.id;
  return false;
}

/**
 * The fields whose value differs between `before` and `after`, in `fields`
 * order. `before === null` is a create: every field with a value is listed,
 * from `null`. An empty result means the save changed nothing — the caller
 * writes no row.
 */
export function diffAuditFields<F extends string>(
  before: Partial<Record<F, AuditValue>> | null,
  after: Partial<Record<F, AuditValue>>,
  fields: readonly F[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    const to = normalize(after[field]);
    const from = before === null ? null : normalize(before[field]);
    if (before === null && to === null) continue;
    if (sameValue(from, to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

function setKey(list: AuditRef[] | string[]): string {
  return (list as (AuditRef | string)[])
    .map((item) => (typeof item === 'string' ? item : item.id))
    .sort()
    .join('\u0000');
}

function normalize(value: AuditValue | undefined): AuditValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.every((item): item is string => typeof item === 'string')) {
      return [...(value as string[])].sort();
    }
    return [...(value as AuditRef[])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((ref) => ({ id: ref.id, name: ref.name }));
  }
  return value;
}

/** A stored `changes` column, read back defensively: anything malformed is dropped, not guessed at. */
export function readAuditChanges(value: Prisma.JsonValue): AuditChange[] {
  if (!Array.isArray(value)) return [];
  const changes: AuditChange[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.field === 'string') {
      changes.push({
        field: item.field,
        from: (item.from ?? null) as AuditValue,
        to: (item.to ?? null) as AuditValue,
      });
    }
  }
  return changes;
}

export function toAuditJson(changes: AuditChange[]): Prisma.InputJsonValue {
  return changes as unknown as Prisma.InputJsonValue;
}
