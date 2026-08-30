import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ServiceCategoryKind, ServiceCategoryStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory, createTestApp, resetDatabase, type TestContext } from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * Reconciling an environment that imported the first two waves before the
 * enrollment column existed.
 *
 * The gap is real, and this file is the proof it is closed safely. The importer
 * writes `providerEnrollmentOpen` only when it creates a category — the same
 * rule it applies to the price and the status — so an operator who closes a
 * draft keeps it closed through the next run. By that same rule, rows written
 * before the column existed stay closed for ever: the definitions say `true`,
 * the rows say `false`, and no import will ever reconcile them.
 *
 * So the reconciliation is a separate, named act, and what matters about it is
 * everything it does *not* touch.
 *
 * The commands are exercised the way an operator runs them — `pnpm run`, from
 * the repository root — against this checkout's own test database. Importing
 * from `prisma/` directly is not an option here: it sits outside this package's
 * rootDir, which is why every import spec in this suite drives the scripts
 * rather than the modules. Nothing here reaches the development database; see
 * test-database.ts, which admits only names in the `_test` family.
 */

const repoRoot = resolve(__dirname, '../../..');

let ctx: TestContext;
let databaseUrl: string;

function runScript(script: string) {
  execFileSync('pnpm', ['run', script], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
}

const importWave1 = () => runScript('db:import:categories');
const importWave2 = () => runScript('db:import:categories:wave-2');
const openEnrollment = () => runScript('db:open-provider-enrollment:wave-1-2');

beforeAll(async () => {
  databaseUrl = resolveTestDatabaseUrl();
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

/**
 * The state a development database imported before the column is in: every wave
 * service present, DRAFT, and closed to applications.
 *
 * Produced by running the real import and then closing what it created, rather
 * than by hand-writing rows. Hand-written rows would be a guess at what the
 * import produces; these are what it produces.
 */
async function importedButClosed(imports: Array<() => void>) {
  for (const run of imports) run();

  await ctx.prisma.serviceCategory.updateMany({
    where: { kind: ServiceCategoryKind.LEAF, status: ServiceCategoryStatus.DRAFT },
    data: { providerEnrollmentOpen: false },
  });

  const waveSlugs = await ctx.prisma.serviceCategory.findMany({
    where: { kind: ServiceCategoryKind.LEAF, status: ServiceCategoryStatus.DRAFT },
    select: { slug: true },
    orderBy: { slug: 'asc' },
  });

  return waveSlugs.map((row) => row.slug);
}

async function categoriesBySlug() {
  const rows = await ctx.prisma.serviceCategory.findMany({
    select: { slug: true, kind: true, status: true, providerEnrollmentOpen: true },
  });
  return new Map(rows.map((row) => [row.slug, row]));
}

describe('the wave 1+2 enrollment reconciliation', () => {
  it('opens the two waves’ thirty-two draft services and nothing else', async () => {
    const waveSlugs = await importedButClosed([importWave1, importWave2]);
    expect(waveSlugs).toHaveLength(32);

    // Four categories the command must leave alone, each for a different
    // reason. The first is the one that proves the command is allow-listed
    // rather than "every draft service": it is a draft service, and it is not
    // one of these two waves'.
    const otherDraft = await createCategory(ctx.prisma, 'Baska Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const closedService = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 3,
    });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });

    openEnrollment();

    const after = await categoriesBySlug();
    for (const slug of waveSlugs) {
      expect(after.get(slug)?.providerEnrollmentOpen, slug).toBe(true);
      // Opened, not released. The command never touches status, so nothing it
      // does can put a service in front of a customer.
      expect(after.get(slug)?.status, slug).toBe(ServiceCategoryStatus.DRAFT);
    }

    for (const untouched of [otherDraft, live, closedService, group]) {
      expect(after.get(untouched.slug)?.providerEnrollmentOpen, untouched.slug).toBe(false);
    }

    // The waves' own groups are drafts too, and are not services.
    const openGroups = await ctx.prisma.serviceCategory.count({
      where: { kind: ServiceCategoryKind.GROUP, providerEnrollmentOpen: true },
    });
    expect(openGroups).toBe(0);
  });

  it('changes nothing on a second run', async () => {
    await importedButClosed([importWave1]);

    openEnrollment();
    const afterFirst = await ctx.prisma.serviceCategory.findMany({
      select: { slug: true, providerEnrollmentOpen: true, status: true, updatedAt: true },
      orderBy: { slug: 'asc' },
    });

    openEnrollment();
    const afterSecond = await ctx.prisma.serviceCategory.findMany({
      select: { slug: true, providerEnrollmentOpen: true, status: true, updatedAt: true },
      orderBy: { slug: 'asc' },
    });

    // updatedAt is in the projection deliberately: "nothing changed" has to
    // mean no write happened, not that a write stored the same value.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('leaves a wave service alone once somebody has released it', async () => {
    const waveSlugs = await importedButClosed([importWave1]);
    const released = waveSlugs[0]!;

    await ctx.prisma.serviceCategory.update({
      where: { slug: released },
      data: { status: ServiceCategoryStatus.ACTIVE, isActive: true, offerCreditCost: 3 },
    });

    openEnrollment();

    const after = await categoriesBySlug();
    // A released service is open to applications by rule, and the stored column
    // is not what says so. The command therefore has nothing to do here, and
    // must not pretend otherwise by writing to a value nothing reads.
    expect(after.get(released)?.providerEnrollmentOpen).toBe(false);
    expect(after.get(released)?.status).toBe(ServiceCategoryStatus.ACTIVE);

    for (const slug of waveSlugs.slice(1)) {
      expect(after.get(slug)?.providerEnrollmentOpen, slug).toBe(true);
    }
  });

  it('does nothing at all where the waves were never imported', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });

    openEnrollment();

    const after = await categoriesBySlug();
    expect(after.size).toBe(1);
    expect(after.get(live.slug)?.providerEnrollmentOpen).toBe(false);
  });
});

describe('the ordinary import and an operator’s decision', () => {
  it('never reopens a draft an operator has closed', async () => {
    // Imported normally: the definitions say these services recruit, and a
    // fresh create honours that.
    importWave1();

    const created = await ctx.prisma.serviceCategory.findFirstOrThrow({
      where: { kind: ServiceCategoryKind.LEAF, status: ServiceCategoryStatus.DRAFT },
      orderBy: { slug: 'asc' },
    });
    expect(created.providerEnrollmentOpen).toBe(true);

    // An operator closes it — a regulated service, an eligibility question, a
    // wave paused. Whatever the reason, it is their decision to make.
    await ctx.prisma.serviceCategory.update({
      where: { id: created.id },
      data: { providerEnrollmentOpen: false },
    });

    importWave1();

    const afterReimport = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(afterReimport.providerEnrollmentOpen).toBe(false);

    // The same guarantee the importer already made for the other two operator
    // decisions, restated here so a change to one is a change to all three.
    expect(afterReimport.status).toBe(created.status);
    expect(afterReimport.offerCreditCost).toBe(created.offerCreditCost);
  });
});
