import { ProviderStatus, ServiceCategoryStatus, UserRole } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The figures an operator releases the first expansion wave on, and who is
 * allowed to read them.
 *
 * category-import-seed.spec.ts checks the import against an empty database —
 * what the wave *is*. category-visibility.spec.ts checks who may ask for the
 * unreleased catalogue at all. This file is about the operation in between:
 * seven categories are live, fifteen unreleased services arrive next to them,
 * and somebody has to decide which of the fifteen are ready.
 *
 * Two of those numbers are new — the offer price and the count of approved
 * providers — and both travel only in the operator's view. A category with no
 * approved provider behind it would publish requests into an empty room, so the
 * count has to be right *and* it has to be a figure a customer or a provider
 * cannot read on their way past.
 */

const repoRoot = resolve(__dirname, '../../..');

const FOUNDING_SLUGS = [
  'boya-badana',
  'elektrikci',
  'ev-temizligi',
  'klima-montaji',
  'klima-servisi',
  'kombi-servisi',
  'su-tesisatcisi',
];

const WAVE_1_GROUPS = [
  'beyaz-esya-teknik-servis',
  'tadilat-ve-yenileme',
  'tasinma-ve-lojistik',
  'temizlik-ve-hijyen',
  'yapi-ve-montaj',
];

const WAVE_1_SERVICES = [
  'asansorlu-tasima',
  'asma-tavan-uygulamasi',
  'banyo-seramik-kaplama',
  'banyo-yenileme',
  'bos-daire-temizligi',
  'bulasik-makinesi-onarimi',
  'camasir-makinesi-onarimi',
  'esya-depolama',
  'evden-eve-tasima',
  'guvenlik-kamerasi-kurulumu',
  'hamaliye-hizmeti',
  'isyeri-tasima',
  'isyeri-temizlik-hizmeti',
  'tadilat-sonrasi-temizlik',
  'yerinde-doseme-yikama',
];

/** The number the wave is reviewed and signed off against. */
const WAVE_1_QUESTION_TOTAL = 81;

type ListedCategory = {
  slug: string;
  status: string;
  kind: string;
  offerCreditCost: number | null;
  parent: { slug: string } | null;
  _count: { questions: number; children: number; providers?: number };
};

let ctx: TestContext;
let databaseUrl: string;

function runImport() {
  execFileSync('pnpm', ['run', 'db:import:categories'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
}

function seed() {
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'seed'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
}

async function cookieFor(role: UserRole) {
  const user = await createUser(ctx.prisma, { role });
  return loginAs(ctx.prisma, user.id);
}

/**
 * The founding seven exactly as they are stored, `updatedAt` included.
 *
 * The timestamp is the point: it is the column that moves on any write at all,
 * so comparing it turns "the import did not change them" from a claim about the
 * fields somebody thought to list into a claim about every write to the row.
 */
async function foundingSnapshot() {
  const categories = await ctx.prisma.serviceCategory.findMany({
    where: { slug: { in: FOUNDING_SLUGS } },
    orderBy: { slug: 'asc' },
  });

  const questions = await ctx.prisma.serviceRequestQuestion.findMany({
    where: { category: { slug: { in: FOUNDING_SLUGS } } },
    orderBy: [{ category: { slug: 'asc' } }, { key: 'asc' }],
  });

  return { categories, questions };
}

/** What "the import changed nothing" is measured in on a second run. */
async function catalogueCounts() {
  const [categories, questions, conditions, routerRules, requests, answers] = await Promise.all([
    ctx.prisma.serviceCategory.count(),
    ctx.prisma.serviceRequestQuestion.count(),
    ctx.prisma.serviceRequestQuestionCondition.count(),
    ctx.prisma.serviceCategoryRouterRule.count(),
    ctx.prisma.serviceRequest.count(),
    ctx.prisma.serviceRequestAnswer.count(),
  ]);

  return { categories, questions, conditions, routerRules, requests, answers };
}

async function operatorListing(): Promise<ListedCategory[]> {
  const response = await request(ctx.server)
    .get('/categories?includeInactive=true')
    .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
    .expect(200);

  return response.body as ListedCategory[];
}

let founding: Awaited<ReturnType<typeof foundingSnapshot>>;

beforeAll(async () => {
  databaseUrl = resolveTestDatabaseUrl();
  ctx = await createTestApp();

  // A database in the state the import is really run against: emptied, then
  // seeded with the seven categories that are already on sale.
  await resetDatabase(ctx.prisma);
  seed();

  founding = await foundingSnapshot();
  expect(founding.categories).toHaveLength(FOUNDING_SLUGS.length);

  runImport();
}, 180_000);

afterAll(async () => {
  await ctx.app.close();
});

describe('wave 1 lands next to a catalogue that is already live', () => {
  it('adds five draft groups and fifteen draft services, and releases none of them', async () => {
    const drafts = await ctx.prisma.serviceCategory.findMany({
      where: { status: ServiceCategoryStatus.DRAFT },
      select: { slug: true, kind: true, isActive: true, parent: { select: { kind: true } } },
      orderBy: { slug: 'asc' },
    });

    expect(drafts).toHaveLength(WAVE_1_GROUPS.length + WAVE_1_SERVICES.length);

    const groups = drafts.filter((category) => category.kind === 'GROUP');
    const services = drafts.filter((category) => category.kind === 'LEAF');

    expect(groups.map((group) => group.slug)).toEqual(WAVE_1_GROUPS);
    expect(services.map((service) => service.slug)).toEqual(WAVE_1_SERVICES);

    // status and isActive are the same fact; a draft that is somehow "active"
    // is on the public catalogue whatever its status column says.
    expect(drafts.every((category) => category.isActive === false)).toBe(true);

    // Every service hangs under one of the five groups — the wave is a tree,
    // not fifteen categories loose at the top level next to the founding seven.
    expect(services.every((service) => service.parent?.kind === 'GROUP')).toBe(true);
    expect(groups.every((group) => group.parent === null)).toBe(true);
  });

  it('gives the fifteen services eighty-one questions between them', async () => {
    const onServices = await ctx.prisma.serviceRequestQuestion.count({
      where: { category: { slug: { in: WAVE_1_SERVICES } } },
    });

    expect(onServices).toBe(WAVE_1_QUESTION_TOTAL);

    // Counted from the other side as well: nothing was written onto a group,
    // which has no form to ask a question on.
    const onGroups = await ctx.prisma.serviceRequestQuestion.count({
      where: { category: { slug: { in: WAVE_1_GROUPS } } },
    });
    expect(onGroups).toBe(0);
  });

  it('leaves the seeded seven and their questions exactly as they were', async () => {
    expect(await foundingSnapshot()).toEqual(founding);
  });
});

describe('the readiness figures a SUPER_ADMIN sees', () => {
  it('carries the parent, the question count, the price and the provider count for every draft service', async () => {
    const categories = await operatorListing();

    expect(categories).toHaveLength(
      FOUNDING_SLUGS.length + WAVE_1_GROUPS.length + WAVE_1_SERVICES.length,
    );

    let questionTotal = 0;

    for (const slug of WAVE_1_SERVICES) {
      const category = categories.find((candidate) => candidate.slug === slug);

      expect(category, slug).toBeDefined();
      expect(category?.status, `${slug} durumu`).toBe('DRAFT');
      expect(category?.parent?.slug, `${slug} üst grubu`).toBeTruthy();
      // The two numbers a release decision is made on. Nothing here releases
      // anything or invents a price: the panel reads what the import wrote.
      expect(category?.offerCreditCost, `${slug} teklif kredisi`).toBeGreaterThan(0);
      expect(category?._count.providers, `${slug} onaylı hizmet veren`).toBe(0);

      questionTotal += category?._count.questions ?? 0;
    }

    // The same 81 the import reports, counted through the screen's own source.
    expect(questionTotal).toBe(WAVE_1_QUESTION_TOTAL);

    const groups = categories.filter((category) => WAVE_1_GROUPS.includes(category.slug));
    expect(groups).toHaveLength(WAVE_1_GROUPS.length);
    expect(groups.every((group) => group.status === 'DRAFT' && group.kind === 'GROUP')).toBe(true);
  });

  it('counts approved providers and ignores the ones that could not take a request', async () => {
    const category = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { slug: 'banyo-yenileme' },
      select: { id: true },
    });

    for (const status of [
      ProviderStatus.APPROVED,
      ProviderStatus.PENDING_REVIEW,
      ProviderStatus.SUSPENDED,
      ProviderStatus.REJECTED,
    ]) {
      const provider = await createProviderProfile(ctx.prisma, { status });
      await ctx.prisma.providerServiceCategory.create({
        data: { providerId: provider.id, categoryId: category.id },
      });
    }

    const categories = await operatorListing();
    const row = categories.find((candidate) => candidate.slug === 'banyo-yenileme');

    // Four rows in ProviderServiceCategory, one provider who could actually be
    // shown a request. A category that counted all four would look staffed and
    // publish into an empty room.
    expect(row?._count.providers).toBe(1);

    // And the count on the detail endpoint, which is what the screen that flips
    // the status reads.
    const detail = await request(ctx.server)
      .get('/categories/banyo-yenileme?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
      .expect(200);

    expect((detail.body as ListedCategory)._count.providers).toBe(1);
  });
});

describe('none of it reaches a caller who is not an operator', () => {
  it('keeps every wave category out of the public catalogue', async () => {
    const response = await request(ctx.server).get('/categories').expect(200);
    const categories = response.body as ListedCategory[];

    expect(categories.map((category) => category.slug).sort()).toEqual(
      [...FOUNDING_SLUGS].sort(),
    );
  });

  it('never puts the provider count on a response the public can read', async () => {
    const listing = await request(ctx.server).get('/categories').expect(200);

    for (const category of listing.body as ListedCategory[]) {
      expect(category._count.providers, `${category.slug} listede`).toBeUndefined();
    }

    // The detail of a category that *is* public still says nothing about who
    // serves it: the figure belongs to the operator's view, not to the entity.
    const detail = await request(ctx.server).get('/categories/ev-temizligi').expect(200);
    expect((detail.body as ListedCategory)._count.providers).toBeUndefined();
  });

  it('keeps the drafts out of a public search that would otherwise match them', async () => {
    // "banyo" is in two of the wave's names and in none of the founding seven,
    // so a leak would show up here and nowhere else.
    const response = await request(ctx.server).get('/categories?q=banyo').expect(200);

    expect(response.body).toEqual([]);
  });

  it('answers a guessed wave slug with 404 rather than a 403 that would confirm it', async () => {
    for (const slug of ['banyo-yenileme', 'evden-eve-tasima', 'temizlik-ve-hijyen']) {
      await request(ctx.server).get(`/categories/${slug}`).expect(404);
    }
  });

  it('refuses the operator view to an anonymous caller, a customer and a provider', async () => {
    const callers: [string, string | null][] = [
      ['anonim', null],
      ['müşteri', await cookieFor(UserRole.CUSTOMER)],
      ['hizmet veren', await cookieFor(UserRole.PROVIDER)],
    ];

    for (const [who, cookie] of callers) {
      for (const path of [
        '/categories?includeInactive=true',
        '/categories/banyo-yenileme?includeInactive=true',
      ]) {
        const call = request(ctx.server).get(path);
        const response = await (cookie ? call.set('Cookie', cookie) : call).expect(403);

        // Not one word of the unreleased wave, and not one of its figures,
        // even in the refusal.
        const body = JSON.stringify(response.body);
        expect(body, `${who} → ${path}`).not.toContain('banyo-yenileme');
        expect(body, `${who} → ${path}`).not.toContain('providers');
      }
    }
  });
});

describe('the second run', () => {
  it('changes no category, question, condition or rule count', async () => {
    const before = await catalogueCounts();

    runImport();

    expect(await catalogueCounts()).toEqual(before);
  });

  it('still leaves the seeded seven alone', async () => {
    expect(await foundingSnapshot()).toEqual(founding);
  });

  it('still shows the public exactly the seven categories that are on sale', async () => {
    const response = await request(ctx.server).get('/categories').expect(200);
    const slugs = (response.body as ListedCategory[]).map((category) => category.slug).sort();

    expect(slugs).toEqual([...FOUNDING_SLUGS].sort());
  });

  it('leaves the readiness figures where they were', async () => {
    const categories = await operatorListing();

    for (const slug of WAVE_1_SERVICES) {
      const category = categories.find((candidate) => candidate.slug === slug);

      expect(category?.status, `${slug} durumu`).toBe('DRAFT');
      expect(category?.offerCreditCost, `${slug} teklif kredisi`).toBeGreaterThan(0);
    }

    // The one category a provider was attached to keeps its count; the import
    // owns the structure of a wave and nothing about who serves it.
    const staffed = categories.find((candidate) => candidate.slug === 'banyo-yenileme');
    expect(staffed?._count.providers).toBe(1);
  });
});
