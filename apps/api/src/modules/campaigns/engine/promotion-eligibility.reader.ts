import { Injectable } from '@nestjs/common';
import {
  BusinessRegistrationType,
  PackagePurchaseStatus,
  PackageRefundRequestStatus,
  Prisma,
  ProviderStatus,
} from '@prisma/client';
import { sessionIpFingerprint } from '../../business-registration/promotion-fingerprint';
import type { PromotionSignals } from './promotion-eligibility';

/**
 * Gathers the signals of `decidePromotionEligibility`, inside the evaluating
 * transaction, from sources that already exist (CMP-006 PR-C design §2.2).
 * Nothing new is collected here: no device data, no payment identity, no
 * address the product did not already store.
 *
 * Identifiers leave this reader as provider ids, counts and versioned HMAC
 * fingerprints — never a registration number, a phone number or an address.
 */

/** `payments-webhook.service.ts` MANUAL_REVIEW_REASON: a signed reversal report for the purchase. */
const PAYMENT_REVERSAL_REASON = 'PAYMENT_REVERSAL_REPORTED';

/** How many other providers a snapshot names per signal. Enough to act on, not a dossier. */
const MAX_LISTED = 5;

@Injectable()
export class PromotionEligibilityReader {
  async read(tx: Prisma.TransactionClient, providerId: string): Promise<PromotionSignals> {
    const provider = await tx.providerProfile.findUnique({
      where: { id: providerId },
      select: {
        userId: true,
        status: true,
        user: { select: { emailVerifiedAt: true, phoneVerifiedAt: true } },
        businessRegistration: { select: { type: true, fingerprint: true, fingerprintVersion: true } },
      },
    });
    if (!provider) {
      throw new Error(`Provider ${providerId} does not exist`);
    }

    const [registration, priorRefund, sharedIp] = await Promise.all([
      this.registration(tx, providerId, provider.businessRegistration),
      this.priorRefund(tx, providerId),
      provider.userId ? this.sharedIp(tx, provider.userId) : Promise.resolve({ otherProviderIds: [], ipFingerprints: [] }),
    ]);

    return {
      hasAccount: provider.userId !== null,
      approved: provider.status === ProviderStatus.APPROVED,
      emailVerified: provider.user?.emailVerifiedAt != null,
      phoneVerified: provider.user?.phoneVerifiedAt != null,
      registration,
      priorRefund,
      sharedIp,
    };
  }

  private async registration(
    tx: Prisma.TransactionClient,
    providerId: string,
    row: { type: BusinessRegistrationType; fingerprint: string | null; fingerprintVersion: number | null } | null,
  ): Promise<PromotionSignals['registration']> {
    if (!row) {
      return { status: 'UNSPECIFIED' };
    }
    if (row.type === BusinessRegistrationType.NONE_DECLARED || !row.fingerprint || !row.fingerprintVersion) {
      return { status: 'NONE_DECLARED' };
    }
    const same = { fingerprint: row.fingerprint, fingerprintVersion: row.fingerprintVersion };
    const [promoted, sharing] = await Promise.all([
      tx.campaignRegistrationCounter.findMany({
        where: { registrationType: row.type, ...same, providerId: { not: providerId } },
        select: { providerId: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_LISTED,
      }),
      tx.providerBusinessRegistration.findMany({
        where: { type: row.type, ...same, providerId: { not: providerId } },
        select: { providerId: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_LISTED,
      }),
    ]);
    return {
      status: 'DECLARED',
      type: row.type,
      fingerprintVersion: row.fingerprintVersion,
      promotedProviderIds: [...new Set(promoted.map((entry) => entry.providerId))],
      sharingProviderIds: sharing.map((entry) => entry.providerId),
    };
  }

  private async priorRefund(tx: Prisma.TransactionClient, providerId: string) {
    const [settledRequests, refundedPurchases, paymentReversals] = await Promise.all([
      tx.packageRefundRequest.count({ where: { providerId, status: PackageRefundRequestStatus.SETTLED } }),
      tx.packagePurchase.count({ where: { providerId, status: PackagePurchaseStatus.REFUNDED } }),
      tx.packagePurchase.count({
        where: { providerId, status: { not: PackagePurchaseStatus.REFUNDED }, manualReviewReason: PAYMENT_REVERSAL_REASON },
      }),
    ]);
    return { settledRequests, refundedPurchases, paymentReversals };
  }

  /**
   * Another provider account signed in from an address this account signed
   * in from (`Session.ipAddress`, already stored at sign-in; nothing new is
   * collected). The comparison is SQL equality; an address that matched is
   * turned into a versioned HMAC before it leaves this method, and only that
   * is kept.
   */
  private async sharedIp(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<Array<{ ipAddress: string; providerId: string }>>`
      SELECT DISTINCT theirs."ipAddress" AS "ipAddress", p."id" AS "providerId"
      FROM "Session" mine
      JOIN "Session" theirs
        ON theirs."ipAddress" = mine."ipAddress" AND theirs."userId" <> mine."userId"
      JOIN "ProviderProfile" p ON p."userId" = theirs."userId"
      WHERE mine."userId" = ${userId} AND mine."ipAddress" IS NOT NULL AND mine."ipAddress" <> ''
      ORDER BY p."id" ASC
      LIMIT 50
    `;
    const otherProviderIds = [...new Set(rows.map((row) => row.providerId))].slice(0, MAX_LISTED);
    const ipFingerprints = [...new Set(rows.map((row) => sessionIpFingerprint(row.ipAddress)))].slice(0, 3);
    return { otherProviderIds, ipFingerprints };
  }
}
