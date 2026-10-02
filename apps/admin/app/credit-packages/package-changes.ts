import { formatMinorAsTurkishLira } from '@taktic/shared';
import type { AdminOfferPackage, OfferPackageType } from '../../lib/api';

/**
 * What a credit-package save changes that a provider pays for
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
 *
 * One function for both sides: the edit form's save button asks for a
 * confirmation when it finds a change here, and `updateCreditPackageAction`
 * demands the `credit-package.update-commercial` proof when it finds one
 * against the package it has just read from the API — never on the form's
 * word. Only the fields of the package's own type are compared, because only
 * those are sent.
 *
 * Commercial: the price and currency, the credits (one-time), the monthly
 * quota, the unlimited package's daily cap and category scope. Not
 * commercial: the name, the slug, the description and the listing order —
 * none of them changes what a purchase buys or costs.
 */

export type CreditPackageTerms = {
  type: OfferPackageType;
  priceAmount: number;
  currency: string;
  creditAmount: number | null;
  quotaCredits: number | null;
  /** 0 and null both mean "no daily cap". */
  dailyOfferLimit: number | null;
  scopeCategoryIds: string[];
};

export type TermsChange = { key: string; label: string; from: string; to: string };

function capText(value: number | null): string {
  return value ? `günlük ${value} teklif` : 'günlük sınır yok';
}

function scopeText(ids: string[], names: Record<string, string>): string {
  if (ids.length === 0) return 'kapsam yok';
  return ids.map((id) => names[id] ?? id).join(', ');
}

export function creditPackageTermsChanges(
  stored: CreditPackageTerms,
  next: CreditPackageTerms,
  categoryNames: Record<string, string> = {},
): TermsChange[] {
  const changes: TermsChange[] = [];
  if (stored.priceAmount !== next.priceAmount || stored.currency !== next.currency) {
    changes.push({
      key: 'price',
      label: 'Fiyat',
      from: formatMinorAsTurkishLira(stored.priceAmount, stored.currency),
      to: formatMinorAsTurkishLira(next.priceAmount, next.currency),
    });
  }
  if (stored.type === 'ONE_TIME_CREDITS' && (stored.creditAmount ?? 0) !== (next.creditAmount ?? 0)) {
    changes.push({ key: 'credits', label: 'Kredi', from: `${stored.creditAmount ?? 0} kredi`, to: `${next.creditAmount ?? 0} kredi` });
  }
  if (stored.type === 'MONTHLY_QUOTA' && (stored.quotaCredits ?? 0) !== (next.quotaCredits ?? 0)) {
    changes.push({
      key: 'quota',
      label: 'Aylık kota',
      from: `${stored.quotaCredits ?? 0} kredi`,
      to: `${next.quotaCredits ?? 0} kredi`,
    });
  }
  if (stored.type === 'CATEGORY_UNLIMITED') {
    if ((stored.dailyOfferLimit || null) !== (next.dailyOfferLimit || null)) {
      changes.push({ key: 'cap', label: 'Günlük teklif limiti', from: capText(stored.dailyOfferLimit), to: capText(next.dailyOfferLimit) });
    }
    const before = [...new Set(stored.scopeCategoryIds)].sort();
    const after = [...new Set(next.scopeCategoryIds)].sort();
    if (before.join('|') !== after.join('|')) {
      changes.push({
        key: 'scope',
        label: 'Kapsam',
        from: scopeText(before, categoryNames),
        to: scopeText(after, categoryNames),
      });
    }
  }
  return changes;
}

/** The one-line "what it sells" for a confirmation, from the figures being saved. */
export function creditPackageOfferText(terms: Pick<CreditPackageTerms, 'type' | 'creditAmount' | 'quotaCredits' | 'dailyOfferLimit'>): string {
  if (terms.type === 'MONTHLY_QUOTA') return `30 gün geçerli ${terms.quotaCredits ?? 0} kredi kota`;
  if (terms.type === 'CATEGORY_UNLIMITED') return `seçili kategorilerde limitsiz teklif (${capText(terms.dailyOfferLimit)})`;
  return `${terms.creditAmount ?? 0} kredi (tek seferlik)`;
}

/** A stored package's terms, as the API returns it. */
export function creditPackageTerms(
  pkg: Pick<
    AdminOfferPackage,
    'type' | 'priceAmount' | 'currency' | 'creditAmount' | 'quotaCredits' | 'dailyOfferLimit' | 'scopeCategories'
  >,
): CreditPackageTerms {
  return {
    type: pkg.type,
    priceAmount: pkg.priceAmount,
    currency: pkg.currency,
    creditAmount: pkg.creditAmount,
    quotaCredits: pkg.quotaCredits,
    dailyOfferLimit: pkg.dailyOfferLimit,
    scopeCategoryIds: pkg.scopeCategories.map((scope) => scope.category.id),
  };
}
