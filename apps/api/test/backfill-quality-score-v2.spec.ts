import { AdminPermission, Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan,
  applyRefusals,
  applyRollback,
  BackfillRefused,
  buildPlan,
  canonicalJson,
  parseArgs,
  rollbackRefusals,
  type BackfillPlan,
} from '../src/scripts/backfill-quality-score-v2';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createSelectQuestion,
  createTestApp,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * QUALITY-SCORE-001: the backfill that moves original-model rows to the
 * current model — against the real tables, because every claim it makes is
 * about what a transaction may and may not write.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx?.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
});

const LEGACY_BREAKDOWN = {
  phonePresent: { points: 20, max: 20, passed: true },
  namePresent: { points: 10, max: 10, passed: true },
  cityDistrictPresent: { points: 15, max: 15, passed: true },
  budgetPresent: { points: 10, max: 10, passed: true },
  preferredDatePresent: { points: 10, max: 10, passed: true },
  urgencyPresent: { points: 5, max: 5, passed: true },
  descriptionDetailed: { points: 0, max: 10, passed: false },
  requiredAnswersComplete: { points: 10, max: 10, passed: true },
};

function readOnly<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return run(tx);
  });
}

function serializable<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
  return ctx.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Everything about the rows that the backfill must not touch. */
async function untouchedColumns() {
  const rows = await ctx.prisma.serviceRequest.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      status: true,
      description: true,
      budgetMin: true,
      urgency: true,
      customerPhone: true,
      approvedAt: true,
      currentRoundId: true,
      deliveryMode: true,
      // Re-scoring is not a change to the request: "Güncellendi" must not move.
      updatedAt: true,
    },
  });
  return canonicalJson(rows);
}

async function seed() {
  const category = await createCategory(ctx.prisma, 'Backfill', { offerCreditCost: 1 });
  await createSelectQuestion(ctx.prisma, {
    categoryId: category.id,
    key: 'marka',
    options: [{ key: 'a', label: 'A' }],
    sortOrder: 1,
  });

  // An inflated original-model row: 90 for a two-word description.
  const inflated = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  await ctx.prisma.serviceRequest.update({
    where: { id: inflated.id },
    data: {
      description: 'Kombi bozuk.',
      budgetMin: 100_000,
      preferredDate: new Date('2026-11-02T00:00:00.000Z'),
      urgency: 'THIS_WEEK',
      qualityScore: 90,
      qualityScoreBreakdown: LEGACY_BREAKDOWN,
    },
  });
  // A seed-era row with no breakdown at all.
  const bare = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  await ctx.prisma.serviceRequest.update({ where: { id: bare.id }, data: { qualityScore: 70 } });
  // Already on the current model: not the backfill's.
  const current = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  await ctx.prisma.serviceRequest.update({
    where: { id: current.id },
    data: {
      qualityScore: 40,
      qualityScoreVersion: 2,
      qualityScoreBreakdown: { descriptionDepth: { points: 0, max: 40, passed: false, applicable: true, meaningfulWords: 0 } },
    },
  });

  return { category, inflated, bare, current };
}

describe('plan', () => {
  it('reads every original-model row, scores it with the current model and writes nothing', async () => {
    const { inflated, bare, current } = await seed();
    const before = await ctx.prisma.serviceRequest.findMany({ orderBy: { id: 'asc' } });

    const plan = await readOnly((tx) => buildPlan(tx));

    expect(plan.rows.map((row) => row.id).sort()).toEqual([inflated.id, bare.id].sort());
    expect(plan.rows.map((row) => row.id)).not.toContain(current.id);

    const inflatedRow = plan.rows.find((row) => row.id === inflated.id)!;
    // 2 words (3/40), no optional answer (0/10), budget 15, dates 15: 33/80.
    expect(inflatedRow.before).toMatchObject({ score: 90, version: 1, label: 'HIGH' });
    expect(inflatedRow.after).toMatchObject({ score: 41, version: 2, label: 'LOW' });
    expect(plan.rows.find((row) => row.id === bare.id)!.flags.noPriorBreakdown).toBe(true);

    expect(plan.summary).toMatchObject({
      rows: 2,
      labelsBefore: { HIGH: 1, MEDIUM: 1, LOW: 0 },
      labelsAfter: { HIGH: 0, MEDIUM: 0, LOW: 2 },
      transitions: { 'HIGH->LOW': 1, 'MEDIUM->LOW': 1 },
      noPriorBreakdown: 1,
    });
    expect(await ctx.prisma.serviceRequest.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('flags a row whose category form changed after it was sent', async () => {
    const { category, inflated } = await seed();
    await ctx.prisma.serviceRequestQuestion.updateMany({
      where: { categoryId: category.id },
      data: { isActive: false },
    });

    const plan = await readOnly((tx) => buildPlan(tx));

    expect(plan.rows.find((row) => row.id === inflated.id)!.flags.questionSetChanged).toBe(true);
    expect(plan.summary.questionSetChanged).toBe(2);
  });

  it('carries ids, numbers and scores — no name, phone, email or description', async () => {
    const { inflated } = await seed();
    const row = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: inflated.id } });

    const text = JSON.stringify(await readOnly((tx) => buildPlan(tx)));

    for (const secret of [row.customerName, row.customerPhone, row.customerEmail, row.description]) {
      expect(secret).toBeTruthy();
      expect(text).not.toContain(secret as string);
    }
  });
});

describe('apply', () => {
  it('moves exactly the planned rows, touches nothing else, and leaves no original-model row', async () => {
    await seed();
    const plan = await readOnly((tx) => buildPlan(tx));
    const untouched = await untouchedColumns();

    const applied = await serializable((tx) => applyPlan(tx, plan, plan.digest));

    expect(applied.kind).toBe('quality-score-v2-applied');
    for (const row of plan.rows) {
      const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } });
      expect(stored.qualityScore).toBe(row.after.score);
      expect(stored.qualityScoreVersion).toBe(2);
      expect(canonicalJson(stored.qualityScoreBreakdown)).toBe(canonicalJson(row.after.breakdown));
    }
    expect(await ctx.prisma.serviceRequest.count({ where: { qualityScoreVersion: 1 } })).toBe(0);
    expect(await untouchedColumns()).toBe(untouched);
  });

  it('is idempotent: the next plan is empty and the old plan is refused', async () => {
    await seed();
    const plan = await readOnly((tx) => buildPlan(tx));
    await serializable((tx) => applyPlan(tx, plan, plan.digest));

    expect((await readOnly((tx) => buildPlan(tx))).rows).toEqual([]);
    const refusals = await readOnly((tx) => applyRefusals(tx, plan, plan.digest));
    expect(refusals.join(' ')).toContain('no longer an original-model row');
  });

  it('writes what the admin recalculation would — it recalculates to the same row', async () => {
    const { inflated } = await seed();
    const plan = await readOnly((tx) => buildPlan(tx));
    await serializable((tx) => applyPlan(tx, plan, plan.digest));
    const moved = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: inflated.id } });

    const { admin } = await createAdminWithPermissions(ctx.prisma, [
      AdminPermission.REQUESTS_READ,
      AdminPermission.REQUESTS_QUALITY_RECALC,
    ]);
    await request(ctx.server)
      .post(`/service-requests/${inflated.id}/recalculate-quality`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(201);

    const recalculated = await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: inflated.id } });
    expect(recalculated.qualityScore).toBe(moved.qualityScore);
    expect(canonicalJson(recalculated.qualityScoreBreakdown)).toBe(canonicalJson(moved.qualityScoreBreakdown));
  });

  it('refuses a wrong digest, an edited plan, a row changed since, and a row the plan does not name', async () => {
    const { category, inflated } = await seed();
    const plan = await readOnly((tx) => buildPlan(tx));

    expect((await readOnly((tx) => applyRefusals(tx, plan, 'deadbeef'))).join(' ')).toContain('--confirm-digest');

    const edited: BackfillPlan = {
      ...plan,
      rows: plan.rows.map((row) => ({ ...row, after: { ...row.after, score: 100 } })),
    };
    expect((await readOnly((tx) => applyRefusals(tx, edited, plan.digest))).join(' ')).toContain('was edited');

    await ctx.prisma.serviceRequest.update({ where: { id: inflated.id }, data: { qualityScore: 91 } });
    await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const refusals = await readOnly((tx) => applyRefusals(tx, plan, plan.digest));
    expect(refusals.join(' ')).toContain(`${inflated.id}: score or breakdown changed`);
    expect(refusals.join(' ')).toContain('not in the plan');

    // And a refused apply writes nothing at all.
    await expect(serializable((tx) => applyPlan(tx, plan, plan.digest))).rejects.toBeInstanceOf(BackfillRefused);
    expect(await ctx.prisma.serviceRequest.count({ where: { qualityScoreVersion: 2 } })).toBe(1);
  });

  it('refuses when the form changed so the row would score differently than planned', async () => {
    const { category } = await seed();
    const plan = await readOnly((tx) => buildPlan(tx));
    // The only optional question goes: its row leaves the denominator, so the
    // same request now scores 33/70 instead of 33/80.
    await ctx.prisma.serviceRequestQuestion.updateMany({
      where: { categoryId: category.id, key: 'marka' },
      data: { isActive: false },
    });

    const refusals = await readOnly((tx) => applyRefusals(tx, plan, plan.digest));
    expect(refusals.join(' ')).toContain('scores differently now');
  });
});

describe('rollback', () => {
  it('puts every row back exactly — a missing breakdown stays missing', async () => {
    const { bare } = await seed();
    const before = await ctx.prisma.serviceRequest.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, qualityScore: true, qualityScoreVersion: true, qualityScoreBreakdown: true },
    });
    const untouched = await untouchedColumns();
    const plan = await readOnly((tx) => buildPlan(tx));
    const applied = await serializable((tx) => applyPlan(tx, plan, plan.digest));

    expect(await readOnly((tx) => rollbackRefusals(tx, applied))).toEqual([]);
    const rolledBack = await serializable((tx) => applyRollback(tx, applied));

    expect(rolledBack.kind).toBe('quality-score-v2-rolled-back');
    const after = await ctx.prisma.serviceRequest.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, qualityScore: true, qualityScoreVersion: true, qualityScoreBreakdown: true },
    });
    expect(canonicalJson(after)).toBe(canonicalJson(before));
    expect(await untouchedColumns()).toBe(untouched);
    expect(after.find((row) => row.id === bare.id)!.qualityScoreBreakdown).toBeNull();
  });

  it('refuses a row changed since the apply and writes nothing', async () => {
    const { inflated } = await seed();
    const plan = await readOnly((tx) => buildPlan(tx));
    const applied = await serializable((tx) => applyPlan(tx, plan, plan.digest));
    await ctx.prisma.serviceRequest.update({ where: { id: inflated.id }, data: { qualityScore: 12 } });

    expect((await readOnly((tx) => rollbackRefusals(tx, applied))).join(' ')).toContain(`${inflated.id}: changed since the apply`);
    await expect(serializable((tx) => applyRollback(tx, applied))).rejects.toBeInstanceOf(BackfillRefused);
    expect(await ctx.prisma.serviceRequest.count({ where: { qualityScoreVersion: 1 } })).toBe(0);
  });
});

describe('arguments', () => {
  it('needs the plan and its digest to apply, and refuses --apply on a plan', () => {
    expect(() => parseArgs(['apply', '--plan', 'x.json'])).toThrow('--confirm-digest');
    expect(() => parseArgs(['plan', '--apply'])).toThrow('only reads');
    expect(() => parseArgs(['rollback'])).toThrow('--manifest');
    expect(() => parseArgs(['delete'])).toThrow('first argument');
    expect(parseArgs(['--', 'apply', '--plan', 'p.json', '--confirm-digest', 'ABC'])).toMatchObject({
      command: 'apply',
      apply: false,
      confirmDigest: 'abc',
    });
  });
});
