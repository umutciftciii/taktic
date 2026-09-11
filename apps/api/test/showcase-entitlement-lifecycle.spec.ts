import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestContext } from './harness';

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

describe('schema', () => {
  it('applies the entitlement migration: the tables exist and the package default is 90 days', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('ShowcaseEntitlement', 'ShowcaseEntitlementReviewPause', 'ShowcasePackageTermsAcceptance')
      ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'ShowcaseEntitlement',
      'ShowcaseEntitlementReviewPause',
      'ShowcasePackageTermsAcceptance',
    ]);

    const pkg = await ctx.prisma.showcasePackage.create({
      data: { name: 'P', slug: 'vitrin-schema-test', priceAmount: 100, durationDays: 30 },
    });
    expect(pkg.activationWindowDays).toBe(90);
  });
});
