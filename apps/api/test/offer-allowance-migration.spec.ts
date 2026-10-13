import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OfferEntitlementSource, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * The 101 migration's one data statement — the grant backfill for runs live at
 * rollout — run as SQL against a representative pre-101 world.
 *
 * The suite's database has every migration applied, so the statement is read
 * from the file on disk (the bytes `prisma migrate deploy` runs) between its
 * BACKFILL markers and executed against placements whose grants the fixture
 * has removed, which is exactly the state a database is in just before 101.
 *
 * What it must do: count each run's legacy zero-credit answers without touching
 * them, grant `count + 3` with `count` used, skip runs that can no longer
 * produce or answer a lead, and write no usage rows.
 */

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261015090000_add_offer_allowances/migration.sql',
);

function backfill(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('-- BEGIN BACKFILL');
  const end = sql.indexOf('-- END BACKFILL');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
});

async function world() {
  const category = await createCategory(ctx.prisma, 'Klima', {
    kind: ServiceCategoryKind.LEAF,
    offerCreditCost: 2,
  });
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: category.id,
    areas: [{ city: 'İstanbul', district: null }],
  });

  async function run(title: string) {
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: provider.id,
      categoryId: category.id,
      title,
    });
    const pkg = await createShowcasePackage(ctx.prisma);
    const { placement } = await createLiveShowcasePlacement(ctx, {
      providerId: provider.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
    });
    return { card, placement };
  }

  /** A lead on the card, answered the pre-101 way: zero credits, no usage row. */
  async function legacyAnswer(cardId: string) {
    const lead = await openLead(cardId);
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: lead.requestId },
      select: { currentRoundId: true },
    });
    await ctx.prisma.serviceRequest.update({
      where: { id: lead.requestId },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    const offer = await ctx.prisma.offer.create({
      data: {
        requestId: lead.requestId,
        providerId: provider.id,
        matchRoundId: row.currentRoundId,
        priceAmount: 150_000,
        message: 'Eski teklif',
        creditCost: 0,
        entitlementSource: OfferEntitlementSource.SHOWCASE_PLACEMENT,
        unviewedRefundPolicy: false,
      },
    });
    // As the old answer path left it: the lead answered by that offer.
    await ctx.prisma.showcaseLead.update({
      where: { id: lead.id },
      data: { status: 'ANSWERED', respondedAt: new Date(), respondedOfferId: offer.id },
    });
    return offer;
  }

  async function openLead(cardId: string) {
    const payload = showcaseLeadPayload(category.slug);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    const created = await request(ctx.server).post(`/showcase/cards/${cardId}/leads`).send(payload);
    expect(created.status).toBe(201);
    return ctx.prisma.showcaseLead.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  }

  return { provider, run, legacyAnswer, openLead };
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000);
}

describe('the 101 grant backfill', () => {
  it('is one INSERT … SELECT into OfferAllowanceGrant, idempotent on the placement, touching nothing else', () => {
    const sql = backfill();
    expect(sql.match(/\bINSERT\b/gi)).toHaveLength(1);
    expect(sql).toMatch(/INSERT INTO "OfferAllowanceGrant"/);
    expect(sql).toMatch(/ON CONFLICT \("showcasePlacementId"\) DO NOTHING/);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|DROP|ALTER|OfferAllowanceUsage/i);
  });

  it('grants count+3 / count to live runs, skips ended ones, keeps open leads of ended runs, and rewrites no offer', async () => {
    const w = await world();
    const fresh = await w.run('Hiç cevapsız');
    const two = await w.run('İki eski cevap');
    const five = await w.run('Beş eski cevap');
    const suspended = await w.run('Askıda');
    const ended = await w.run('Bitmiş');
    const endedWithOpenLead = await w.run('Bitmiş ama açık talepli');
    const staleActive = await w.run('Süresi geçmiş ACTIVE');

    for (let i = 0; i < 2; i += 1) await w.legacyAnswer(two.card.id);
    for (let i = 0; i < 5; i += 1) await w.legacyAnswer(five.card.id);
    await w.legacyAnswer(ended.card.id);
    const openLead = await w.openLead(endedWithOpenLead.card.id);

    // Pre-101: no grants anywhere.
    await ctx.prisma.offerAllowanceGrant.deleteMany({});

    await ctx.prisma.showcasePlacement.update({
      where: { id: suspended.placement.id },
      data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendReason: 'ADMIN_ACTION' },
    });
    for (const id of [ended.placement.id, endedWithOpenLead.placement.id]) {
      await ctx.prisma.showcasePlacement.update({
        where: { id },
        data: { status: 'EXPIRED', startAt: minutesAgo(10), endAt: minutesAgo(5) },
      });
    }
    await ctx.prisma.showcasePlacement.update({
      where: { id: staleActive.placement.id },
      data: { startAt: minutesAgo(10), endAt: minutesAgo(5) },
    });

    const offersBefore = await ctx.prisma.offer.findMany({ orderBy: { id: 'asc' } });
    expect(offersBefore).toHaveLength(8);

    const inserted = await ctx.prisma.$executeRawUnsafe(backfill());
    expect(inserted).toBe(5);

    const grants = await ctx.prisma.offerAllowanceGrant.findMany();
    const byPlacement = new Map(grants.map((grant) => [grant.showcasePlacementId, grant]));
    expect(byPlacement.get(fresh.placement.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 0 });
    expect(byPlacement.get(two.placement.id)).toMatchObject({ quotaTotal: 5, quotaUsed: 2 });
    expect(byPlacement.get(five.placement.id)).toMatchObject({ quotaTotal: 8, quotaUsed: 5 });
    expect(byPlacement.get(suspended.placement.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 0 });
    expect(byPlacement.get(endedWithOpenLead.placement.id)).toMatchObject({ quotaTotal: 3, quotaUsed: 0 });
    expect(byPlacement.has(ended.placement.id)).toBe(false);
    expect(byPlacement.has(staleActive.placement.id)).toBe(false);
    for (const grant of grants) {
      expect(grant).toMatchObject({
        id: `oag_${grant.showcasePlacementId}`,
        providerId: w.provider.id,
        source: 'SHOWCASE_PLACEMENT',
        benefit: 'FREE_OFFER',
        status: 'ACTIVE',
        voidedAt: null,
      });
    }
    const freshPlacement = await ctx.prisma.showcasePlacement.findUniqueOrThrow({ where: { id: fresh.placement.id } });
    expect(byPlacement.get(fresh.placement.id)!.validFrom).toEqual(freshPlacement.startAt);

    // Legacy answers are counted, never rewritten, and get no usage row.
    expect(await ctx.prisma.offer.findMany({ orderBy: { id: 'asc' } })).toEqual(offersBefore);
    expect(await ctx.prisma.offerAllowanceUsage.count()).toBe(0);

    // A second run of the statement is a no-op.
    expect(await ctx.prisma.$executeRawUnsafe(backfill())).toBe(0);

    // And the open lead of the ended run can still spend from its new grant.
    expect(openLead.placementId).toBe(endedWithOpenLead.placement.id);
  });
});
