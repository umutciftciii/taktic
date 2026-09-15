import { prisma, uniquePhone, uniqueSuffix, type Location } from './fixtures';

/**
 * Provider-review rows written straight to the database, for the parts of
 * a scenario that are not its subject.
 *
 * The switch and the completed jobs behind the public threshold are seeded
 * here; the review a scenario is *about* is written through the real
 * screens. Every value is restated rather than imported from the API —
 * this suite talks to the application over HTTP and to the database through
 * Prisma, and must not share a constant with the code it is testing.
 */

const OPERATIONS_SETTINGS_ID = 'singleton';
const DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS = 48;

/**
 * Turns provider reviews on or off, the way the API reads them.
 *
 * The shipped default is OFF and every other spec relies on it — a completed
 * request shows no review call to action anywhere. A spec that turns it on
 * must put it back in `afterEach`, so a failure halfway through cannot leave
 * the rest of the run on the wrong side of the rule.
 *
 * Written without an audit row: the audit trail is what the admin action
 * writes, and a reset that pretended to be an operator's decision would put
 * a false entry on the operations screen.
 */
export async function setProviderReviewsEnabled(enabled: boolean): Promise<void> {
  await prisma().operationsSettings.upsert({
    where: { id: OPERATIONS_SETTINGS_ID },
    create: {
      id: OPERATIONS_SETTINGS_ID,
      unviewedOfferRefundWindowHours: DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
      providerReviewsEnabled: enabled,
    },
    update: { providerReviewsEnabled: enabled },
  });
}

/** Whether the switch is on right now, read the way the API reads it. */
export async function isProviderReviewsEnabled(): Promise<boolean> {
  const row = await prisma().operationsSettings.findUnique({
    where: { id: OPERATIONS_SETTINGS_ID },
    select: { providerReviewsEnabled: true },
  });
  return row?.providerReviewsEnabled ?? false;
}

/** Live reviews of one provider — what the public average is computed from. */
export async function liveReviewCount(providerId: string): Promise<number> {
  return prisma().providerReview.count({ where: { providerId, removedAt: null } });
}

/**
 * A COMPLETED request with its ACCEPTED offer for one provider, written
 * straight into the tables: the fixture behind "three reviews" and "the
 * window closed", where the job itself is not what the scenario is about.
 *
 * `completedAt` may be backdated to put the job outside the review window.
 */
export async function seedCompletedJob(options: {
  providerId: string;
  categoryId: string;
  customerId: string;
  location: Location;
  completedAt?: Date;
}) {
  const db = prisma();
  const suffix = uniqueSuffix();
  const now = new Date();
  const completedAt = options.completedAt ?? now;

  const request = await db.serviceRequest.create({
    data: {
      categoryId: options.categoryId,
      customerId: options.customerId,
      requestNumber: `TR-E2E-${suffix}`,
      customerName: `E2E Müşteri ${suffix}`,
      customerPhone: uniquePhone(),
      customerEmail: `e2e-review-${suffix}@example.test`,
      city: options.location.city,
      district: options.location.district,
      status: 'APPROVED',
      approvedAt: now,
      qualityScore: 80,
      phoneVerifiedAt: now,
    },
    select: { id: true },
  });

  const offer = await db.offer.create({
    data: {
      requestId: request.id,
      providerId: options.providerId,
      status: 'ACCEPTED',
      acceptedAt: completedAt,
      priceAmount: 150_000,
      message: 'Teklif',
    },
    select: { id: true },
  });

  await db.serviceRequest.update({
    where: { id: request.id },
    data: {
      status: 'COMPLETED',
      matchedOfferId: offer.id,
      matchedAt: completedAt,
      completedAt,
    },
  });

  return { requestId: request.id, offerId: offer.id };
}

/** One review on a fresh completed job, written as the customer would have. */
export async function seedReview(options: {
  providerId: string;
  categoryId: string;
  customerId: string;
  location: Location;
  rating: number;
  comment?: string | null;
}) {
  const job = await seedCompletedJob(options);
  const review = await prisma().providerReview.create({
    data: {
      requestId: job.requestId,
      offerId: job.offerId,
      providerId: options.providerId,
      customerUserId: options.customerId,
      rating: options.rating,
      comment: options.comment ?? null,
    },
    select: { id: true },
  });
  return { ...job, reviewId: review.id };
}
