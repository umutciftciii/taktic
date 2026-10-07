import { CatalogAuditAction, CatalogAuditEntity, Prisma } from '@prisma/client';
import { staffActorSelect } from '../modules/auth/embedded-permissions';
import type { AuthUser } from '../modules/auth/auth.types';
import {
  AdminAuditDomain,
  AdminAuditEntry,
  AdminAuditPage,
  AUDIT_ORDER,
  AuditPageQueryDto,
  AuditRef,
  AuditValue,
  auditPage,
  auditPaging,
  diffAuditFields,
  readAuditChanges,
  toAuditActor,
  toAuditJson,
} from './admin-audit';

/**
 * ADMIN-ACTION-AUDIT-001 — the catalogue's change log: categories, credit
 * packages and showcase packages, in one append-only table (CatalogAuditLog).
 *
 * Each write path builds a snapshot of the audited fields from the database
 * row before and after its own write, inside its own transaction, and hands
 * both to {@link recordCatalogAudit}. Only differing fields are stored; a save
 * that changed nothing stores nothing. References (a parent category, the
 * categories a package covers) are stored with the name they had at that
 * moment, so a later rename does not rewrite history.
 */

/** Category fields, in the order the screen lists them. `isActive` is `status` respelt and is not repeated. */
export const CATEGORY_AUDIT_FIELDS = [
  'name',
  'slug',
  'kind',
  'parent',
  'status',
  'offerCreditCost',
  'unlimitedPackageEligible',
  'providerEnrollmentOpen',
  'description',
  'sortOrder',
  'iconKey',
  'imageUrl',
  'coverImageUrl',
  // SEO-004: the page's own SEO content. The FAQ is recorded as its JSON
  // text, so a change to any question or answer is one visible diff.
  'seoTitle',
  'seoDescription',
  'editorialDecisionGuide',
  'editorialPriceFactors',
  'editorialFaq',
] as const;

export const CREDIT_PACKAGE_AUDIT_FIELDS = [
  'name',
  'slug',
  'type',
  'priceAmount',
  'currency',
  'creditAmount',
  'quotaCredits',
  'periodDays',
  'dailyOfferLimit',
  'scopeCategories',
  'isActive',
  'description',
  'sortOrder',
] as const;

export const SHOWCASE_PACKAGE_AUDIT_FIELDS = [
  'name',
  'slug',
  'priceAmount',
  'currency',
  'durationDays',
  'allowedCardKind',
  'maxAreas',
  'requiresAdminApproval',
  'activationWindowDays',
  'isActive',
  'description',
  'sortOrder',
] as const;

/** Per entity, the fields whose change alone makes a save a STATUS_CHANGED. */
const STATUS_FIELDS: Record<CatalogAuditEntity, readonly string[]> = {
  CATEGORY: ['status'],
  CREDIT_PACKAGE: ['isActive'],
  SHOWCASE_PACKAGE: ['isActive'],
};

const DOMAIN: Record<CatalogAuditEntity, AdminAuditDomain> = {
  CATEGORY: 'CATEGORY',
  CREDIT_PACKAGE: 'CREDIT_PACKAGE',
  SHOWCASE_PACKAGE: 'SHOWCASE_PACKAGE',
};

export type CatalogSnapshot = Record<string, AuditValue>;

type CategoryRow = {
  name: string;
  slug: string;
  kind: string;
  parentId: string | null;
  status: string;
  offerCreditCost: number | null;
  unlimitedPackageEligible: boolean;
  providerEnrollmentOpen: boolean;
  description: string | null;
  sortOrder: number;
  iconKey: string | null;
  imageUrl: string | null;
  coverImageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  editorialDecisionGuide: string | null;
  editorialPriceFactors: string | null;
  editorialFaq: Prisma.JsonValue | null;
};

/** A category row as audited values; the parent is resolved to `{ id, name }`. */
export async function categoryAuditSnapshot(
  tx: Prisma.TransactionClient,
  row: CategoryRow,
): Promise<CatalogSnapshot> {
  let parent: AuditRef | null = null;
  if (row.parentId) {
    const found = await tx.serviceCategory.findUnique({
      where: { id: row.parentId },
      select: { id: true, name: true },
    });
    parent = { id: row.parentId, name: found?.name ?? null };
  }
  return {
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    parent,
    status: row.status,
    offerCreditCost: row.offerCreditCost,
    unlimitedPackageEligible: row.unlimitedPackageEligible,
    providerEnrollmentOpen: row.providerEnrollmentOpen,
    description: row.description,
    sortOrder: row.sortOrder,
    iconKey: row.iconKey,
    imageUrl: row.imageUrl,
    coverImageUrl: row.coverImageUrl,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    editorialDecisionGuide: row.editorialDecisionGuide,
    editorialPriceFactors: row.editorialPriceFactors,
    editorialFaq: row.editorialFaq === null ? null : JSON.stringify(row.editorialFaq),
  };
}

/** The select a credit package snapshot is built from. */
export const creditPackageAuditSelect = {
  name: true,
  slug: true,
  type: true,
  priceAmount: true,
  currency: true,
  creditAmount: true,
  quotaCredits: true,
  periodDays: true,
  dailyOfferLimit: true,
  isActive: true,
  description: true,
  sortOrder: true,
  scopeCategories: { select: { category: { select: { id: true, name: true } } } },
} satisfies Prisma.OfferCreditPackageSelect;

export function creditPackageAuditSnapshot(
  row: Prisma.OfferCreditPackageGetPayload<{ select: typeof creditPackageAuditSelect }>,
): CatalogSnapshot {
  const { scopeCategories, ...fields } = row;
  return {
    ...fields,
    scopeCategories: scopeCategories.map((scope) => ({ id: scope.category.id, name: scope.category.name })),
  };
}

export const showcasePackageAuditSelect = {
  name: true,
  slug: true,
  priceAmount: true,
  currency: true,
  durationDays: true,
  allowedCardKind: true,
  maxAreas: true,
  requiresAdminApproval: true,
  activationWindowDays: true,
  isActive: true,
  description: true,
  sortOrder: true,
} satisfies Prisma.ShowcasePackageSelect;

export function showcasePackageAuditSnapshot(
  row: Prisma.ShowcasePackageGetPayload<{ select: typeof showcasePackageAuditSelect }>,
): CatalogSnapshot {
  return { ...row };
}

const FIELDS: Record<CatalogAuditEntity, readonly string[]> = {
  CATEGORY: CATEGORY_AUDIT_FIELDS,
  CREDIT_PACKAGE: CREDIT_PACKAGE_AUDIT_FIELDS,
  SHOWCASE_PACKAGE: SHOWCASE_PACKAGE_AUDIT_FIELDS,
};

/**
 * Writes one audit row for a create (`before === null`) or a change, inside
 * the caller's transaction. Returns `false`, writing nothing, when no audited
 * field differs.
 */
export async function recordCatalogAudit(
  tx: Prisma.TransactionClient,
  input: {
    entityType: CatalogAuditEntity;
    entityId: string;
    before: CatalogSnapshot | null;
    after: CatalogSnapshot;
    actorId: string;
  },
): Promise<boolean> {
  const changes = diffAuditFields(input.before, input.after, FIELDS[input.entityType]);
  if (changes.length === 0) return false;

  const statusFields = STATUS_FIELDS[input.entityType];
  const action =
    input.before === null
      ? CatalogAuditAction.CREATED
      : changes.every((change) => statusFields.includes(change.field))
        ? CatalogAuditAction.STATUS_CHANGED
        : CatalogAuditAction.UPDATED;

  await tx.catalogAuditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action,
      changes: toAuditJson(changes),
      actorId: input.actorId,
    },
    select: { id: true },
  });
  return true;
}

type CatalogAuditHost = { catalogAuditLog: Prisma.TransactionClient['catalogAuditLog'] };

/** One record's catalogue history, newest first. The caller has checked the record and the permission. */
export async function readCatalogAudit(
  prisma: CatalogAuditHost,
  entityType: CatalogAuditEntity,
  entityId: string,
  query: AuditPageQueryDto | undefined,
  viewer: AuthUser,
): Promise<AdminAuditPage> {
  const { page, pageSize, skip } = auditPaging(query);
  const where = { entityType, entityId } satisfies Prisma.CatalogAuditLogWhereInput;
  const [total, rows] = await Promise.all([
    prisma.catalogAuditLog.count({ where }),
    prisma.catalogAuditLog.findMany({
      where,
      orderBy: [...AUDIT_ORDER],
      skip,
      take: pageSize,
      select: { id: true, action: true, changes: true, createdAt: true, actor: staffActorSelect(viewer) },
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
      reason: null,
      createdAt: row.createdAt,
    }),
  );
  return auditPage(items, total, page, pageSize);
}
