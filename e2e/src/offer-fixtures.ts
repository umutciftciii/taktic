import { prisma, recordCreditTransaction, uniqueSuffix } from './fixtures';

/**
 * An offer written straight into the tables, the way the offer-creation path
 * would have left it: a one-time-credit spend on the ledger, and — when asked
 * for — the unviewed-offer refund snapshot with its eligibility moment already
 * in the past, so the refund scan and the manual refund have a real candidate.
 *
 * For the admin screens, where the offer is the subject rather than the act of
 * sending it (offer-experience.spec.ts sends real ones).
 */
export async function seedOffer(options: {
  requestId: string;
  providerId: string;
  creditCost?: number;
  priceAmount?: number;
  status?: 'SUBMITTED' | 'VIEWED' | 'SHORTLISTED' | 'ACCEPTED';
  /** `eligible`: in policy, unviewed, window over. `none`: outside the policy. */
  refund?: 'eligible' | 'none';
}) {
  const creditCost = options.creditCost ?? 3;
  const refund = options.refund ?? 'none';
  const submittedAt = new Date(Date.now() - 50 * 60 * 60 * 1000);
  const spend = await recordCreditTransaction({
    providerId: options.providerId,
    type: 'OFFER_SPEND',
    amount: -creditCost,
    reason: 'E2E fixture offer spend',
  });

  return prisma().offer.create({
    data: {
      offerNumber: `TK-E2E-${uniqueSuffix()}`,
      requestId: options.requestId,
      providerId: options.providerId,
      status: options.status ?? 'SUBMITTED',
      acceptedAt: options.status === 'ACCEPTED' ? new Date() : null,
      priceAmount: options.priceAmount ?? 175_000,
      message: 'Yarın akşam gelebiliriz; keşif ücretsiz.',
      creditCost,
      entitlementSource: 'ONE_TIME_CREDIT',
      creditSpentTransactionId: spend.id,
      submittedAt,
      unviewedRefundPolicy: refund === 'eligible',
      unviewedRefundWindowHours: refund === 'eligible' ? 48 : null,
      unviewedRefundEligibleAt: refund === 'eligible' ? new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000) : null,
    },
    select: { id: true, offerNumber: true },
  });
}

/** One provider's report of a request, open unless a resolution is given. */
export async function seedRequestReport(options: {
  requestId: string;
  reporterProviderId: string;
  note?: string;
}) {
  return prisma().serviceRequestReport.create({
    data: {
      requestId: options.requestId,
      reporterProviderId: options.reporterProviderId,
      reason: 'FAKE_OR_TEST',
      note: options.note ?? 'Müşteri telefonu açmıyor, adres yanlış görünüyor.',
    },
    select: { id: true },
  });
}
