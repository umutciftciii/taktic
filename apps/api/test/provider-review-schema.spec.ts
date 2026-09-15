import { ProviderReviewReportReason, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

/** A completed request with its accepted offer, written straight into the tables. */
async function completedJob() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    categoryId: category.id,
    userId: owner.id,
  });
  const req = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
  });
  await grantCredits(ctx.prisma, provider.id, 5);
  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${req.id}/offers`)
    .set('Cookie', await loginAs(ctx.prisma, owner.id))
    .send(offerPayload())
    .expect(201);
  await ctx.prisma.offer.update({
    where: { id: created.body.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });
  await ctx.prisma.serviceRequest.update({
    where: { id: req.id },
    data: {
      status: 'COMPLETED',
      matchedOfferId: created.body.id,
      matchedAt: new Date(),
      completedAt: new Date(),
    },
  });
  return { customer, provider, request: req, offerId: created.body.id as string };
}

describe('ProviderReview schema', () => {
  it('allows one review per request + provider and per offer', async () => {
    const job = await completedJob();
    const data = {
      requestId: job.request.id,
      offerId: job.offerId,
      providerId: job.provider.id,
      customerUserId: job.customer.id,
      rating: 5,
    };
    await ctx.prisma.providerReview.create({ data });
    await expect(
      ctx.prisma.providerReview.create({ data: { ...data, rating: 1 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // The CHECK constraints below are raw SQL that Prisma's schema never
  // declares, so the query engine has no known error code for them: they
  // surface as PrismaClientUnknownRequestError (see
  // request-report-schema.spec.ts). Asserted against the constraint name in the
  // underlying Postgres error so the test fails loudly if some other, unrelated
  // error started rejecting the insert instead.
  it('refuses a rating outside 1..5 (CHECK ProviderReview_rating_range)', async () => {
    const job = await completedJob();
    await expect(
      ctx.prisma.providerReview.create({
        data: {
          requestId: job.request.id,
          offerId: job.offerId,
          providerId: job.provider.id,
          customerUserId: job.customer.id,
          rating: 6,
        },
      }),
    ).rejects.toThrow(/ProviderReview_rating_range/);
  });

  it('refuses commentRemovedAt on a review with no comment', async () => {
    const job = await completedJob();
    await expect(
      ctx.prisma.providerReview.create({
        data: {
          requestId: job.request.id,
          offerId: job.offerId,
          providerId: job.provider.id,
          customerUserId: job.customer.id,
          rating: 4,
          comment: null,
          commentRemovedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/ProviderReview_comment_removal_needs_comment/);
  });

  it('allows one OPEN report per review and a second one after a decision', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({
      data: {
        requestId: job.request.id,
        offerId: job.offerId,
        providerId: job.provider.id,
        customerUserId: job.customer.id,
        rating: 2,
        comment: 'Kötü',
      },
    });
    const first = await ctx.prisma.providerReviewReport.create({
      data: {
        reviewId: review.id,
        reporterProviderId: job.provider.id,
        reason: ProviderReviewReportReason.OFFENSIVE,
      },
    });
    // The partial unique index ("ProviderReviewReport_one_open_per_review",
    // WHERE "resolvedAt" IS NULL) is raw SQL, yet Prisma still maps its
    // violation to P2002 on `reviewId` — the query engine reads the column list
    // out of the Postgres unique-violation error. The resolved-then-create half
    // below is what proves the index is partial and not a plain unique.
    await expect(
      ctx.prisma.providerReviewReport.create({
        data: {
          reviewId: review.id,
          reporterProviderId: job.provider.id,
          reason: ProviderReviewReportReason.OTHER,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['reviewId'] } });
    await ctx.prisma.providerReviewReport.update({
      where: { id: first.id },
      data: { resolvedAt: new Date(), resolution: 'DISMISSED' },
    });
    await expect(
      ctx.prisma.providerReviewReport.create({
        data: {
          reviewId: review.id,
          reporterProviderId: job.provider.id,
          reason: ProviderReviewReportReason.OTHER,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('pairs resolvedAt with resolution and reason with action', async () => {
    const job = await completedJob();
    const review = await ctx.prisma.providerReview.create({
      data: {
        requestId: job.request.id,
        offerId: job.offerId,
        providerId: job.provider.id,
        customerUserId: job.customer.id,
        rating: 3,
      },
    });
    await expect(
      ctx.prisma.providerReviewReport.create({
        data: {
          reviewId: review.id,
          reporterProviderId: job.provider.id,
          reason: 'OTHER',
          resolvedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/ProviderReviewReport_resolution_pair/);
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await expect(
      ctx.prisma.providerReviewModeration.create({
        data: { reviewId: review.id, action: 'REMOVE_REVIEW', reason: null, performedById: admin.id },
      }),
    ).rejects.toThrow(/ProviderReviewModeration_reason_by_action/);
    await expect(
      ctx.prisma.providerReviewModeration.create({
        data: { reviewId: review.id, action: 'RESTORE', reason: 'OTHER', performedById: admin.id },
      }),
    ).rejects.toThrow(/ProviderReviewModeration_reason_by_action/);
  });
});
