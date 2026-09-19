import { Injectable } from '@nestjs/common';
import { PackagePurchaseKind, PackagePurchaseStatus, type Prisma } from '@prisma/client';
import type { ProviderFacts, PurchaseFacts } from './condition-evaluator';

/**
 * The facts a condition may ask about, read inside the trigger transaction
 * from the tables that hold them (CMP-001 §2.2 "Kaynak (sunucu)" column).
 *
 * Reads only. The purchase read returns null for a purchase that is not this
 * provider's or is not PAID — a payment event must name a settled purchase of
 * the provider it is raised for, and anything else is a caller error the
 * engine reports as ENGINE_ERROR rather than evaluates.
 */
@Injectable()
export class CampaignFactReader {
  async provider(tx: Prisma.TransactionClient, providerId: string): Promise<ProviderFacts | null> {
    const row = await tx.providerProfile.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        status: true,
        approvedAt: true,
        userId: true,
        user: { select: { emailVerifiedAt: true, phoneVerifiedAt: true } },
      },
    });
    if (!row) {
      return null;
    }
    const [priorApproval, revoked] = await Promise.all([
      tx.campaignRedemption.count({ where: { providerId, trigger: 'PROVIDER_APPROVED' } }),
      tx.campaignRedemption.count({ where: { providerId, status: 'REVOKED' } }),
    ]);
    return {
      providerId: row.id,
      userId: row.userId,
      status: row.status,
      approvedAt: row.approvedAt,
      emailVerifiedAt: row.user?.emailVerifiedAt ?? null,
      phoneVerifiedAt: row.user?.phoneVerifiedAt ?? null,
      hasPriorApprovalRedemption: priorApproval > 0,
      hasRevokedRedemption: revoked > 0,
    };
  }

  async purchase(tx: Prisma.TransactionClient, providerId: string, purchaseId: string): Promise<PurchaseFacts | null> {
    const row = await tx.packagePurchase.findUnique({
      where: { id: purchaseId },
      select: {
        id: true,
        providerId: true,
        status: true,
        kind: true,
        priceAmountSnapshot: true,
        currencySnapshot: true,
        package: { select: { slug: true, type: true } },
      },
    });
    if (!row || row.providerId !== providerId || row.status !== PackagePurchaseStatus.PAID) {
      return null;
    }
    const others = await tx.packagePurchase.count({
      where: {
        providerId,
        status: PackagePurchaseStatus.PAID,
        kind: PackagePurchaseKind.OFFER_PACKAGE,
        id: { not: purchaseId },
      },
    });
    return {
      purchaseId: row.id,
      kind: row.kind,
      packageSlug: row.package?.slug ?? null,
      packageType: row.package?.type ?? null,
      priceAmountSnapshot: row.priceAmountSnapshot,
      currencySnapshot: row.currencySnapshot,
      hasOtherPaidOfferPurchase: others > 0,
    };
  }
}
