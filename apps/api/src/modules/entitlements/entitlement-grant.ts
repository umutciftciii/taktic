import { ConflictException, HttpStatus } from '@nestjs/common';
import {
  OfferPackageType,
  Prisma,
  ProviderEntitlementStatus,
  ServiceCategoryKind,
} from '@prisma/client';
import { PACKAGE_PERIOD_DAYS, nextPeriodStart, periodEnd } from './entitlement-period';

export const SCOPE_CONFLICT_CODE = 'UNLIMITED_SCOPE_CONFLICT';
export const ALREADY_QUEUED_CODE = 'PACKAGE_PERIOD_ALREADY_QUEUED';

/** The package fields a grant needs. Read inside the settlement transaction. */
export type GrantablePackage = {
  id: string;
  name: string;
  type: OfferPackageType;
  priceAmount: number;
  currency: string;
  quotaCredits: number | null;
  periodDays: number | null;
  dailyOfferLimit: number | null;
};

/**
 * Turns a settled payment into a period.
 *
 * Called from inside the settlement transaction of both payment paths — the
 * signature-verified webhook and the in-app mock form — so a period and the
 * purchase that paid for it are committed together or not at all. The unique
 * index on `ProviderPackageEntitlement.purchaseId` is the second half of that
 * guarantee: a redelivered webhook that somehow got past the `PROCESSED`
 * short-circuit still cannot produce a second period.
 *
 * Returns null for a ONE_TIME_CREDITS purchase, which grants a balance rather
 * than a period and is left exactly as it was.
 */
export async function grantEntitlementForPurchase(
  tx: Prisma.TransactionClient,
  input: {
    providerId: string;
    purchaseId: string;
    paidAt: Date;
    packageId: string;
    priceAmountSnapshot: number;
    currencySnapshot: string;
    packageNameSnapshot: string;
    paymentProvider: string | null;
  },
): Promise<{ id: string } | null> {
  const pkg = await tx.offerCreditPackage.findUnique({
    where: { id: input.packageId },
    select: {
      id: true,
      name: true,
      type: true,
      priceAmount: true,
      currency: true,
      quotaCredits: true,
      periodDays: true,
      dailyOfferLimit: true,
    },
  });

  if (!pkg || pkg.type === OfferPackageType.ONE_TIME_CREDITS) {
    return null;
  }

  // Chaining, not topping up. A provider who buys the same package again while
  // the current period is running gets a second period that begins when the
  // first one ends — never a longer period, never a refilled quota, and never
  // one that starts running while they still hold the one they paid for.
  const previous = await tx.providerPackageEntitlement.findFirst({
    where: {
      providerId: input.providerId,
      packageId: pkg.id,
      status: ProviderEntitlementStatus.ACTIVE,
      endAt: { gt: input.paidAt },
    },
    orderBy: [{ endAt: 'desc' }],
    select: { endAt: true },
  });

  const periodDays = pkg.periodDays ?? PACKAGE_PERIOD_DAYS;
  const startAt = nextPeriodStart(input.paidAt, previous?.endAt ?? null);
  const endAt = periodEnd(startAt, periodDays);

  const entitlement = await tx.providerPackageEntitlement.create({
    data: {
      providerId: input.providerId,
      packageId: pkg.id,
      purchaseId: input.purchaseId,
      type: pkg.type,
      // The snapshot is taken from the purchase, not from the package: the
      // purchase already froze the price when the checkout was opened, and a
      // package repriced in between must not rewrite what this period cost.
      packageNameSnapshot: input.packageNameSnapshot,
      priceAmountSnapshot: input.priceAmountSnapshot,
      currencySnapshot: input.currencySnapshot,
      quotaCreditsSnapshot: pkg.type === OfferPackageType.MONTHLY_QUOTA ? pkg.quotaCredits : null,
      remainingQuota: pkg.type === OfferPackageType.MONTHLY_QUOTA ? pkg.quotaCredits : null,
      dailyOfferLimitSnapshot: pkg.dailyOfferLimit,
      periodDaysSnapshot: periodDays,
      startAt,
      endAt,
      status: ProviderEntitlementStatus.ACTIVE,
      paymentProvider: input.paymentProvider,
    },
    select: { id: true },
  });

  if (pkg.type === OfferPackageType.CATEGORY_UNLIMITED) {
    await snapshotScope(tx, pkg.id, entitlement.id);
  }

  return entitlement;
}

/**
 * Freezes the package's category scope onto the period.
 *
 * Every selected node is written, and so is every descendant of a selected
 * group, each marked as expanded rather than selected. The expansion happens
 * once, here, so a group that gains a child next week does not widen a period
 * that was already paid for — and so the resolver can answer "is this request
 * in scope" with a single indexed lookup instead of a tree walk on the hot
 * path.
 */
async function snapshotScope(
  tx: Prisma.TransactionClient,
  packageId: string,
  entitlementId: string,
) {
  const selected = await tx.offerPackageScopeCategory.findMany({
    where: { packageId },
    select: { category: { select: { id: true, name: true, kind: true } } },
  });

  const rows = new Map<string, { name: string; kind: ServiceCategoryKind; selected: boolean }>();
  for (const item of selected) {
    rows.set(item.category.id, {
      name: item.category.name,
      kind: item.category.kind,
      selected: true,
    });
  }

  let frontier = selected.map((item) => item.category.id);
  while (frontier.length > 0) {
    const children = await tx.serviceCategory.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true, name: true, kind: true },
    });

    frontier = [];
    for (const child of children) {
      if (rows.has(child.id)) {
        continue;
      }
      rows.set(child.id, { name: child.name, kind: child.kind, selected: false });
      frontier.push(child.id);
    }
  }

  if (rows.size === 0) {
    return;
  }

  await tx.providerPackageEntitlementScope.createMany({
    data: [...rows.entries()].map(([categoryId, row]) => ({
      entitlementId,
      categoryId,
      categoryNameSnapshot: row.name,
      categoryKindSnapshot: row.kind,
      selected: row.selected,
    })),
  });
}

/**
 * The pre-purchase guard: what a provider is not allowed to buy right now.
 *
 * Two refusals, both deterministic and both stated to the buyer before any
 * money moves:
 *
 * 1. A CATEGORY_UNLIMITED package whose scope overlaps an unlimited period the
 *    provider already holds from a *different* package. Two overlapping
 *    unlimited periods are not harmful — the resolver has a total order over
 *    them — but they are money spent twice for one thing, so the buyer is told
 *    rather than charged.
 * 2. A second queued period for the same package. Renewing early is fine and is
 *    how manual renewal works; queueing a third month on top of a queued second
 *    one is almost always a double submit, and it is not undoable from inside
 *    the application.
 *
 * Deliberately advisory rather than structural: the corresponding races are
 * closed by the resolver's ordering and by the unique index on `purchaseId`,
 * not by this. It runs at checkout, where refusing is still free.
 */
export async function assertPackageIsPurchasable(
  tx: Prisma.TransactionClient,
  input: { providerId: string; pkg: GrantablePackage; now: Date },
) {
  if (input.pkg.type === OfferPackageType.ONE_TIME_CREDITS) {
    return;
  }

  const queued = await tx.providerPackageEntitlement.findFirst({
    where: {
      providerId: input.providerId,
      packageId: input.pkg.id,
      status: ProviderEntitlementStatus.ACTIVE,
      startAt: { gt: input.now },
    },
    select: { id: true },
  });

  if (queued) {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: ALREADY_QUEUED_CODE,
      message:
        'Bu paket için zaten sıraya alınmış bir sonraki dönem var. Mevcut dönem bittikten sonra tekrar yenileyebilirsiniz.',
    });
  }

  if (input.pkg.type !== OfferPackageType.CATEGORY_UNLIMITED) {
    return;
  }

  const wanted = await expandPackageScope(tx, input.pkg.id);
  if (wanted.size === 0) {
    return;
  }

  const conflict = await tx.providerPackageEntitlement.findFirst({
    where: {
      providerId: input.providerId,
      type: OfferPackageType.CATEGORY_UNLIMITED,
      status: ProviderEntitlementStatus.ACTIVE,
      endAt: { gt: input.now },
      // A second period of the *same* package is the renewal path, and it
      // chains rather than overlaps. Only a different package can conflict.
      packageId: { not: input.pkg.id },
      scopes: { some: { categoryId: { in: [...wanted] } } },
    },
    select: { id: true, packageNameSnapshot: true, endAt: true },
  });

  if (conflict) {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: SCOPE_CONFLICT_CODE,
      message:
        `"${conflict.packageNameSnapshot}" paketiniz bu kategorileri zaten kapsıyor. ` +
        'Mevcut paketiniz bittikten sonra bu paketi alabilirsiniz.',
    });
  }
}

/**
 * Every category a package's scope reaches today: the selected nodes and every
 * descendant of the selected groups.
 *
 * Used only by the pre-purchase guard, which asks about the package as it
 * stands right now. The purchase-time snapshot is written by
 * {@link grantEntitlementForPurchase} and is what everything afterwards reads.
 */
async function expandPackageScope(tx: Prisma.TransactionClient, packageId: string) {
  const selected = await tx.offerPackageScopeCategory.findMany({
    where: { packageId },
    select: { categoryId: true },
  });

  const all = new Set(selected.map((row) => row.categoryId));
  let frontier = [...all];

  while (frontier.length > 0) {
    const children = await tx.serviceCategory.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });

    frontier = [];
    for (const child of children) {
      if (all.has(child.id)) {
        continue;
      }
      all.add(child.id);
      frontier.push(child.id);
    }
  }

  return all;
}
