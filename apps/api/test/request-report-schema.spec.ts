import { Prisma, ServiceRequestReportReason } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
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

describe('ServiceRequestReport schema', () => {
  it('refuses a second report from the same provider on the same request', async () => {
    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    await ctx.prisma.serviceRequestReport.create({
      data: { requestId: request.id, reporterProviderId: provider.id, reason: ServiceRequestReportReason.SPAM },
    });

    await expect(
      ctx.prisma.serviceRequestReport.create({
        data: { requestId: request.id, reporterProviderId: provider.id, reason: ServiceRequestReportReason.OTHER },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // The database enforces this with a raw CHECK constraint
  // (ServiceRequestReport_resolution_pair) that Prisma's schema never declares,
  // so the query engine has no known error code for it (unlike P2002/P2003):
  // it surfaces as PrismaClientUnknownRequestError, not
  // PrismaClientKnownRequestError. Asserted here against the constraint name in
  // the underlying Postgres error so the test fails loudly if some other,
  // unrelated error started rejecting the insert instead.
  it('refuses a resolution without a resolvedAt (CHECK)', async () => {
    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });

    const create = ctx.prisma.serviceRequestReport.create({
      data: {
        requestId: request.id,
        reporterProviderId: provider.id,
        reason: ServiceRequestReportReason.SPAM,
        resolution: 'DISMISSED',
      },
    });

    await expect(create).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    await expect(create).rejects.toThrow(/ServiceRequestReport_resolution_pair/);
  });

  it('ships the new columns with their safe defaults', async () => {
    const settings = await ctx.prisma.operationsSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', unviewedOfferRefundWindowHours: 48 },
      update: {},
    });
    expect(settings.marketplaceAutoPublishEnabled).toBe(false);

    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, { categoryId: category.id });
    const request = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const offer = await ctx.prisma.offer.create({
      data: { requestId: request.id, providerId: provider.id, priceAmount: 1000, message: 'x' },
    });
    expect(offer.cancelledAt).toBeNull();
  });
});
