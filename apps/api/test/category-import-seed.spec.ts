import {
  PrismaClient,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
} from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The first expansion wave, applied by the real import script against the
 * isolated test database — twice.
 *
 * Running it twice is the point. "Idempotent" is a promise an operator relies
 * on when they re-run an import after a partial failure or a merge, and the
 * only way to hold the promise is to check that the second run leaves the
 * database exactly as the first one did.
 *
 * The script is executed as a subprocess rather than imported, for the same
 * reason category-pricing-seed.spec.ts executes the seed: what is under test is
 * the command a person actually runs, not a function that resembles it.
 */

const repoRoot = resolve(__dirname, '../../..');

/** The wave, and the question count each service ends up with. */
const WAVE_1_SERVICES: Record<string, number> = {
  'isyeri-temizlik-hizmeti': 6,
  'tadilat-sonrasi-temizlik': 5,
  'yerinde-doseme-yikama': 7,
  'bos-daire-temizligi': 4,
  'evden-eve-tasima': 7,
  'isyeri-tasima': 7,
  'esya-depolama': 5,
  'asansorlu-tasima': 6,
  'hamaliye-hizmeti': 8,
  'banyo-yenileme': 5,
  'asma-tavan-uygulamasi': 5,
  'banyo-seramik-kaplama': 6,
  'camasir-makinesi-onarimi': 3,
  'bulasik-makinesi-onarimi': 3,
  'guvenlik-kamerasi-kurulumu': 4,
};

const WAVE_1_GROUPS = [
  'temizlik-ve-hijyen',
  'tasinma-ve-lojistik',
  'tadilat-ve-yenileme',
  'beyaz-esya-teknik-servis',
  'yapi-ve-montaj',
];

/**
 * Excluded from the first wave by decision, not by omission: health,
 * psychology, nutrition, insurance and occupational-safety services need
 * regulatory review before they can be sold, and a draft category is one status
 * change away from being sold.
 */
const EXCLUDED_TOPICS = [
  'psikolog',
  'saglik',
  'sağlık',
  'diyetisyen',
  'beslenme',
  'sigorta',
  'isg',
  'is-guvenligi',
];

let prisma: PrismaClient;
let databaseUrl: string;

function runImport() {
  execFileSync('pnpm', ['run', 'db:import:categories'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
}

/**
 * Everything an operator would notice, in a form two runs can be compared by.
 * Timestamps are excluded on purpose: `updatedAt` moves on every write and says
 * nothing about whether the catalogue changed.
 */
async function snapshot() {
  const categories = await prisma.serviceCategory.findMany({
    orderBy: { slug: 'asc' },
    select: {
      slug: true,
      name: true,
      description: true,
      kind: true,
      status: true,
      isActive: true,
      sortOrder: true,
      offerCreditCost: true,
      iconKey: true,
      parent: { select: { slug: true } },
    },
  });

  const questions = await prisma.serviceRequestQuestion.findMany({
    orderBy: [{ category: { slug: 'asc' } }, { key: 'asc' }],
    select: {
      key: true,
      label: true,
      helpText: true,
      type: true,
      isRequired: true,
      options: true,
      systemField: true,
      isRouter: true,
      sortOrder: true,
      isActive: true,
      category: { select: { slug: true } },
      conditions: {
        orderBy: { sourceQuestion: { key: 'asc' } },
        select: { expectedValues: true, sourceQuestion: { select: { key: true } } },
      },
      routerRules: {
        orderBy: { optionKey: 'asc' },
        select: { optionKey: true, targetCategory: { select: { slug: true } } },
      },
    },
  });

  return { categories, questions };
}

beforeAll(async () => {
  databaseUrl = resolveTestDatabaseUrl();
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  // A clean database, so every claim below is about what the import leaves
  // behind rather than about whatever the previous spec file left.
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('wave 1 draft category import', () => {
  it('creates five groups and fifteen services, all as drafts', async () => {
    runImport();

    const categories = await prisma.serviceCategory.findMany({
      select: { slug: true, kind: true, status: true, isActive: true, parent: { select: { slug: true } } },
    });

    expect(categories).toHaveLength(WAVE_1_GROUPS.length + Object.keys(WAVE_1_SERVICES).length);

    for (const category of categories) {
      // Nothing this wave writes is visible to a customer or to provider
      // discovery until somebody releases it deliberately.
      expect(category.status).toBe(ServiceCategoryStatus.DRAFT);
      expect(category.isActive).toBe(false);
    }

    const groups = categories.filter((category) => category.kind === ServiceCategoryKind.GROUP);
    expect(groups.map((group) => group.slug).sort()).toEqual([...WAVE_1_GROUPS].sort());

    const leaves = categories.filter((category) => category.kind === ServiceCategoryKind.LEAF);
    expect(leaves.map((leaf) => leaf.slug).sort()).toEqual(
      Object.keys(WAVE_1_SERVICES).sort(),
    );

    // Every service hangs off a group: the wave is a tree, not fifteen loose
    // categories at the top level.
    for (const leaf of leaves) {
      expect(leaf.parent?.slug).toBeTruthy();
    }
  });

  it('contains no router in the first wave', async () => {
    const routers = await prisma.serviceCategory.count({
      where: { kind: ServiceCategoryKind.ROUTER },
    });
    const routerQuestions = await prisma.serviceRequestQuestion.count({ where: { isRouter: true } });

    expect(routers).toBe(0);
    expect(routerQuestions).toBe(0);
  });

  it('leaves out the regulated topics the first wave excludes', async () => {
    const categories = await prisma.serviceCategory.findMany({
      select: { slug: true, name: true },
    });

    for (const category of categories) {
      const haystack = `${category.slug} ${category.name}`.toLocaleLowerCase('tr-TR');
      for (const topic of EXCLUDED_TOPICS) {
        expect(haystack).not.toContain(topic);
      }
    }
  });

  it('gives every service its question set, and prices every one of them', async () => {
    for (const [slug, expectedQuestions] of Object.entries(WAVE_1_SERVICES)) {
      const category = await prisma.serviceCategory.findUniqueOrThrow({
        where: { slug },
        include: { _count: { select: { questions: true } } },
      });

      expect(category._count.questions, `${slug} soru sayısı`).toBe(expectedQuestions);
      // A leaf with no price cannot receive offers, so releasing it would be a
      // category that looks live and silently is not.
      expect(category.offerCreditCost, `${slug} teklif kredisi`).toBeGreaterThan(0);
    }
  });

  it('binds the mandatory free-text step to the request’s own description', async () => {
    const bound = await prisma.serviceRequestQuestion.findMany({
      where: { systemField: ServiceRequestQuestionSystemField.DESCRIPTION },
      select: { isRequired: true, category: { select: { slug: true } } },
    });

    // One per service: the research found a mandatory "tell us more" step on
    // every one of the fifteen, and in Taktic that is the request's own
    // description field rather than a second copy of it.
    expect(bound).toHaveLength(Object.keys(WAVE_1_SERVICES).length);
    expect(bound.every((question) => question.isRequired)).toBe(true);

    // A bound question never renders an input of its own, so it has no options
    // to render: it labels a field the request already has.
    const boundWithOptions = await prisma.serviceRequestQuestion.findMany({
      where: { systemField: { not: null } },
      select: { key: true, options: true },
    });
    expect(boundWithOptions.every((question) => question.options === null)).toBe(true);
  });

  it('makes the moving date the request’s own preferredDate field', async () => {
    const bound = await prisma.serviceRequestQuestion.findMany({
      where: { systemField: ServiceRequestQuestionSystemField.PREFERRED_DATE },
      select: { isRequired: true, category: { select: { slug: true } } },
    });

    expect(bound.map((question) => question.category.slug).sort()).toEqual([
      'evden-eve-tasima',
      'isyeri-tasima',
    ]);
    expect(bound.every((question) => question.isRequired)).toBe(true);
  });

  it('carries the conditional question the bathroom form needs', async () => {
    const conditional = await prisma.serviceRequestQuestion.findFirstOrThrow({
      where: { key: 'yapilacak_isler', category: { slug: 'banyo-yenileme' } },
      include: { conditions: { include: { sourceQuestion: true } } },
    });

    expect(conditional.conditions).toHaveLength(1);
    expect(conditional.conditions[0]?.sourceQuestion.key).toBe('tadilat_tipi');
    expect(conditional.conditions[0]?.expectedValues).toEqual(['komple']);
    // The ordering rule that keeps the dependency graph acyclic.
    expect(conditional.conditions[0]?.sourceQuestion.sortOrder).toBeLessThan(
      conditional.sortOrder,
    );
  });

  it('changes nothing on a second run', async () => {
    const before = await snapshot();
    runImport();
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it('does not reopen a category an operator released, or reprice one they repriced', async () => {
    // The two decisions the import deliberately does not own.
    await prisma.serviceCategory.update({
      where: { slug: 'hamaliye-hizmeti' },
      data: { status: ServiceCategoryStatus.ACTIVE, isActive: true, offerCreditCost: 9 },
    });

    runImport();

    const category = await prisma.serviceCategory.findUniqueOrThrow({
      where: { slug: 'hamaliye-hizmeti' },
    });

    expect(category.status).toBe(ServiceCategoryStatus.ACTIVE);
    expect(category.isActive).toBe(true);
    expect(category.offerCreditCost).toBe(9);
  });
});
