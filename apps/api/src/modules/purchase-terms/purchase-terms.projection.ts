import type { Prisma } from '@prisma/client';

/**
 * CMP-006 PR-A. The purchase-terms evidence is not part of any purchase
 * projection — provider, admin list or detail, finance overview, checkout
 * response. The acceptance row (snapshot, digest, client address, user agent)
 * is reached only by the future permissioned refund-review surface; omitting
 * the two link columns as well keeps every existing response byte-for-byte
 * what it was while the gate is closed.
 */
export const purchaseTermsEvidenceOmit = {
  termsAcceptanceRequired: true,
  purchaseTermsAcceptanceId: true,
} satisfies Prisma.PackagePurchaseOmit;
