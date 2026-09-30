import type { PackagePurchase } from '../../../lib/api';

export type ShowcasePackageSales = {
  /** This package's purchases, newest first. */
  rows: PackagePurchase[];
  paid: number;
  pending: number;
  /** Paid revenue per currency, from the purchase-time snapshots. */
  revenue: Array<[string, number]>;
  /** Runs on the air right now. */
  live: number;
  /**
   * Paid purchases that have not become a run. Not "unused right": whether the
   * right is still usable, reserved or lapsed is an entitlement fact the
   * purchase projection does not carry, so this figure claims only what it
   * can see.
   */
  paidWithoutRun: number;
};

/**
 * One vitrin package's sales and runs, from the whole purchase list
 * (ADMIN-DESIGN-001 Faz 3F.1). The list's only package filter is the credit
 * package's `packageId`; a vitrin purchase names its package in
 * `showcasePackage`, so the rows are picked here.
 */
export function showcasePackageSales(packageId: string, purchases: PackagePurchase[]): ShowcasePackageSales {
  const rows = purchases
    .filter((purchase) => purchase.showcasePackage?.id === packageId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const paidRows = rows.filter((purchase) => purchase.status === 'PAID');
  const revenue = new Map<string, number>();
  for (const purchase of paidRows) {
    const currency = purchase.currencySnapshot || 'TRY';
    revenue.set(currency, (revenue.get(currency) ?? 0) + purchase.priceAmountSnapshot);
  }

  return {
    rows,
    paid: paidRows.length,
    pending: rows.filter((purchase) => purchase.status === 'PENDING').length,
    revenue: [...revenue.entries()],
    live: rows.filter((purchase) => purchase.showcasePlacement?.status === 'ACTIVE').length,
    paidWithoutRun: paidRows.filter((purchase) => !purchase.showcasePlacement).length,
  };
}
