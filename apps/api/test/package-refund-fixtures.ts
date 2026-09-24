import {
  AdminPermission,
  CreditTransactionType,
  OfferPackageType,
  PackagePurchaseStatus,
  type PrismaClient,
  SourceChannel,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  consumePromoCreditsForSpend,
  grantPromoCreditLot,
} from '../src/modules/credits/promo-credit-ledger';
import {
  PURCHASE_TERMS_DOCUMENT_SET,
  type PurchaseTermsDocumentSet,
} from '../src/modules/purchase-terms/purchase-terms.documents';
import { buildPurchaseTermsSnapshot } from '../src/modules/purchase-terms/purchase-terms.snapshot';
import { createCampaignFixture } from './campaign-fixtures';
import {
  createAdminWithPermissions,
  createOfferPackage,
  createProviderProfile,
  createUser,
  loginAs,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * CMP-006 PR-B — shared fixtures for the package refund request specs.
 *
 * Purchases are written straight to the tables, acceptance first and purchase
 * second in one transaction, exactly the order the checkout uses (the
 * acceptance's composite FK is deferred to commit). The settlement spec goes
 * through the real sandbox checkout and webhook instead; everything else is
 * about what an already-paid purchase can become.
 */

export const TERMS = PURCHASE_TERMS_DOCUMENT_SET;
export const ACCEPTED_TERMS = { termsAccepted: true, termsVersion: TERMS.version };

export const ALL_REFUND_PERMISSIONS = [
  AdminPermission.PACKAGE_REFUND_READ,
  AdminPermission.PACKAGE_REFUND_REQUEST_CREATE,
  AdminPermission.PACKAGE_REFUND_APPROVE,
];

/** Remembers PURCHASE_TERMS_GATE so every spec leaves it as it found it. */
export function gateSwitch() {
  let original: string | undefined;
  return {
    remember() {
      original = process.env.PURCHASE_TERMS_GATE;
    },
    open() {
      process.env.PURCHASE_TERMS_GATE = 'on';
    },
    /** PR-B.1: the TEST document set; NODE_ENV=test in the worker permits it. */
    openTest() {
      process.env.PURCHASE_TERMS_GATE = 'test';
    },
    close() {
      delete process.env.PURCHASE_TERMS_GATE;
    },
    restore() {
      if (original === undefined) delete process.env.PURCHASE_TERMS_GATE;
      else process.env.PURCHASE_TERMS_GATE = original;
    },
  };
}

export async function providerAccount(ctx: TestContext) {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
  const cookie = await loginAs(ctx.prisma, owner.id);
  return { owner, provider, cookie };
}

export async function operator(ctx: TestContext, permissions: AdminPermission[] = ALL_REFUND_PERMISSIONS) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return { admin, cookie: await loginAs(ctx.prisma, admin.id) };
}

/**
 * A PAID credit-package purchase. With `evidence` (the default) it carries a
 * purchase-terms acceptance, as every purchase made with the gate open does;
 * without, it is a legacy row from before the gate.
 */
export async function paidPurchase(
  prisma: PrismaClient,
  input: {
    providerId: string;
    userId: string;
    paidAt?: Date;
    evidence?: boolean;
    type?: OfferPackageType;
    status?: PackagePurchaseStatus;
    /** PR-B.1: the document set the evidence records; the production draft by default. */
    terms?: PurchaseTermsDocumentSet;
  },
) {
  const terms = input.terms ?? TERMS;
  const pkg = await createOfferPackage(prisma, { type: input.type, creditAmount: 25, priceAmount: 49_900 });
  const id = `pp-${randomUUID()}`;
  const evidence = input.evidence ?? true;
  const suffix = uniqueSuffix();

  return prisma.$transaction(async (tx) => {
    const acceptance = evidence
      ? await tx.purchaseTermsAcceptance.create({
          data: {
            purchaseId: id,
            userId: input.userId,
            documentKey: terms.documentKey,
            documentVersion: terms.version,
            documentSha256: terms.sha256,
            documentTextSnapshot: buildPurchaseTermsSnapshot(terms),
            clientIp: '203.0.113.77',
            userAgent: 'Mozilla/5.0 (RefundCanaryAgent/1.0)',
            sourceChannel: SourceChannel.WEB,
          },
        })
      : null;

    return tx.packagePurchase.create({
      data: {
        id,
        purchaseNumber: `PKG-2026-${suffix.padStart(6, '0')}`,
        providerId: input.providerId,
        packageId: pkg.id,
        status: input.status ?? PackagePurchaseStatus.PAID,
        paidAt: input.paidAt ?? new Date(Date.now() - 60 * 60 * 1000),
        creditAmountSnapshot: pkg.creditAmount,
        priceAmountSnapshot: pkg.priceAmount,
        packageNameSnapshot: pkg.name,
        paymentReference: `ref-canary-${suffix}`,
        providerOrderId: `order-canary-${suffix}`,
        termsAcceptanceRequired: evidence,
        purchaseTermsAcceptanceId: acceptance?.id ?? null,
      },
    });
  });
}

/** An offer spend on the provider's account at `createdAt`. */
export async function offerSpend(prisma: PrismaClient, providerId: string, createdAt = new Date()) {
  return prisma.providerCreditTransaction.create({
    data: { providerId, type: CreditTransactionType.OFFER_SPEND, amount: -1, balanceAfter: 0, createdAt },
  });
}

/** A promo lot granted for `purchaseId`, then one credit of it spent. */
export async function consumeLinkedPromo(prisma: PrismaClient, providerId: string, purchaseId: string) {
  const { campaign, version } = await createCampaignFixture(prisma, {
    trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
    credits: 5,
  });
  const key = `PACKAGE_PAYMENT_SUCCEEDED:${purchaseId}:${uniqueSuffix()}`;
  const event = await prisma.campaignTriggerEvent.create({
    data: { triggerEventKey: key, trigger: 'PACKAGE_PAYMENT_SUCCEEDED', providerId, purchaseId },
  });
  const redemption = await prisma.campaignRedemption.create({
    data: {
      campaignId: campaign.id,
      campaignVersionId: version.id,
      providerId,
      trigger: 'PACKAGE_PAYMENT_SUCCEEDED',
      triggerEventId: event.id,
      triggerEventKey: key,
      purchaseId,
      rulesSnapshot: {},
      grantedCredits: 5,
    },
  });
  await prisma.$transaction(
    (tx) =>
      grantPromoCreditLot(tx, {
        providerId,
        redemptionId: redemption.id,
        credits: 5,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        now: new Date(),
      }),
    { isolationLevel: 'Serializable' },
  );
  // Spent *before* paidAt could not be, so the spend is the only one — but the
  // purchase is also blocked by CREDIT_SPENT; callers that want the promo code
  // alone check for it among the blocking codes.
  await prisma.$transaction(
    async (tx) => {
      const spend = await tx.providerCreditTransaction.create({
        data: { providerId, type: CreditTransactionType.OFFER_SPEND, amount: -1, balanceAfter: 4 },
      });
      await consumePromoCreditsForSpend(tx, {
        providerId,
        spendTransactionId: spend.id,
        creditCost: 1,
        now: new Date(),
      });
    },
    { isolationLevel: 'Serializable' },
  );
}

/** The provider's refund ticket, over HTTP. */
export function openRefundTicket(ctx: TestContext, cookie: string, purchaseId: string, message = 'Paketi yanlışlıkla aldım, iade rica ediyorum.') {
  return request(ctx.server)
    .post('/support/tickets')
    .set('Cookie', cookie)
    .send({ topic: 'PACKAGE_AND_CREDIT_REFUND', packagePurchaseId: purchaseId, message });
}

export async function requestOfTicket(prisma: PrismaClient, ticketId: string) {
  return prisma.packageRefundRequest.findUniqueOrThrow({ where: { supportTicketId: ticketId } });
}

export function adminCall(ctx: TestContext, cookie: string) {
  return {
    list: (query = '') => request(ctx.server).get(`/admin/package-refund-requests${query}`).set('Cookie', cookie),
    detail: (id: string) => request(ctx.server).get(`/admin/package-refund-requests/${id}`).set('Cookie', cookie),
    create: (body: Record<string, unknown>) =>
      request(ctx.server).post('/admin/package-refund-requests').set('Cookie', cookie).send(body),
    take: (id: string) => request(ctx.server).post(`/admin/package-refund-requests/${id}/take`).set('Cookie', cookie),
    approve: (id: string, body: Record<string, unknown>) =>
      request(ctx.server).post(`/admin/package-refund-requests/${id}/approve`).set('Cookie', cookie).send(body),
    reject: (id: string, reason: string) =>
      request(ctx.server).post(`/admin/package-refund-requests/${id}/reject`).set('Cookie', cookie).send({ reason }),
    settlementFailed: (id: string, reason: string) =>
      request(ctx.server)
        .post(`/admin/package-refund-requests/${id}/settlement-failed`)
        .set('Cookie', cookie)
        .send({ reason }),
  };
}
