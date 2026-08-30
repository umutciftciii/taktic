import {
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  UserRole,
} from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { resolveTestDatabaseUrl } from './test-database';

/**
 * The second expansion wave, applied on top of everything that came before it.
 *
 * The state under test is the one the import is really run against: seven
 * categories already on sale, fifteen unreleased services from wave 1 next to
 * them, and seventeen more arriving. So the file has two jobs, and the second
 * is the larger one.
 *
 * What the wave *is*: five new draft groups, seventeen draft services under
 * seven groups, 102 questions, three conditions and — deliberately — no price
 * on any of them. The research settled on no credit cost Taktic could stand
 * behind for these seventeen, and a made-up number would be worse than none: it
 * would read as a decision on the readiness panel. NULL reads as the blocker it
 * is.
 *
 * What the wave must *not* disturb: the founding seven, wave 1, and the line
 * between the operator's view of the catalogue and everybody else's. Seventeen
 * unreleased services are seventeen new chances for a name, a slug, a question
 * set or a headcount to appear on a surface a competitor can read, so the
 * leak checks here are run against the wave's own slugs rather than against a
 * fixture.
 *
 * Ownership stays where it already is: category-import-seed.spec.ts owns wave 1
 * against an empty database, wave-1-release-readiness.spec.ts owns the readiness
 * figures, and provider-invite-links.spec.ts owns the invitation link itself.
 * This file owns wave 2 and the arithmetic of the two waves together.
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

/** The five groups wave 2 opens. The other two it uses belong to wave 1. */
const WAVE_2_GROUPS = [
  'dijital-ve-yaratici',
  'egitim',
  'etkinlik',
  'kurumsal-ve-danismanlik',
  'saglik-ve-wellness',
];

/**
 * The wave itself: every service, the group it hangs under and the number of
 * questions it ends up with. This table is the contract — it is the same one
 * docs/research/p0-dalga-2-hizmet-envanteri.md is reviewed against.
 */
const WAVE_2_SERVICES: Record<string, { parent: string; questions: number }> = {
  'anahtar-teslim-tadilat': { parent: 'tadilat-ve-yenileme', questions: 8 },
  'banyo-dolabi-uretimi': { parent: 'tadilat-ve-yenileme', questions: 6 },
  'celik-kapi-montaji': { parent: 'yapi-ve-montaj', questions: 5 },
  'dusakabin-montaji': { parent: 'yapi-ve-montaj', questions: 5 },
  'direksiyon-dersi': { parent: 'egitim', questions: 6 },
  'gitar-dersi': { parent: 'egitim', questions: 7 },
  'etkinlik-yemek-servisi': { parent: 'etkinlik', questions: 7 },
  'dugun-fotografciligi': { parent: 'etkinlik', questions: 6 },
  'beslenme-danismanligi': { parent: 'saglik-ve-wellness', questions: 5 },
  'on-muhasebe-hizmeti': { parent: 'kurumsal-ve-danismanlik', questions: 6 },
  'marka-tescil-danismanligi': { parent: 'kurumsal-ve-danismanlik', questions: 5 },
  'sirket-kurulus-danismanligi': { parent: 'kurumsal-ve-danismanlik', questions: 5 },
  'isg-danismanligi': { parent: 'kurumsal-ve-danismanlik', questions: 6 },
  'arama-motoru-optimizasyonu': { parent: 'dijital-ve-yaratici', questions: 6 },
  'sosyal-medya-yonetimi': { parent: 'dijital-ve-yaratici', questions: 6 },
  'mobil-uygulama-gelistirme': { parent: 'dijital-ve-yaratici', questions: 7 },
  'urun-fotograf-cekimi': { parent: 'dijital-ve-yaratici', questions: 6 },
};

const WAVE_2_SLUGS = Object.keys(WAVE_2_SERVICES);

function questionCountOf(slug: string): number {
  const entry = WAVE_2_SERVICES[slug];

  if (!entry) {
    throw new Error(`${slug} bu dalgada tanımlı değil`);
  }

  return entry.questions;
}

/** The number the wave is reviewed and signed off against. */
const WAVE_2_QUESTION_TOTAL = 102;

/** The two services whose release needs a decision outside this system. */
const REGULATED_SLUGS = ['beslenme-danismanligi', 'isg-danismanligi'];

type ListedCategory = {
  slug: string;
  name: string;
  status: string;
  kind: string;
  offerCreditCost: number | null;
  parent: { slug: string } | null;
  _count: { questions: number; children: number; providers?: number };
};

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
 * A set of categories exactly as they are stored, `updatedAt` included.
 *
 * The timestamp is the point: it is the column that moves on any write at all,
 * so comparing it turns "wave 2 did not touch these" from a claim about the
 * fields somebody thought to list into a claim about every write to the row.
 */
async function snapshotOf(slugs: readonly string[]) {
  const categories = await ctx.prisma.serviceCategory.findMany({
    where: { slug: { in: [...slugs] } },
    orderBy: { slug: 'asc' },
  });

  const questions = await ctx.prisma.serviceRequestQuestion.findMany({
    where: { category: { slug: { in: [...slugs] } } },
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

let founding: Awaited<ReturnType<typeof snapshotOf>>;
let waveOne: Awaited<ReturnType<typeof snapshotOf>>;
let beforeWaveTwo: Awaited<ReturnType<typeof catalogueCounts>>;

beforeAll(async () => {
  databaseUrl = resolveTestDatabaseUrl();
  ctx = await createTestApp();

  // The database as it stands the moment before wave 2 is applied: emptied,
  // seeded with the seven categories on sale, then wave 1 imported.
  await resetDatabase(ctx.prisma);
  seed();
  importWave1();

  founding = await snapshotOf(FOUNDING_SLUGS);
  waveOne = await snapshotOf([...WAVE_1_GROUPS, ...WAVE_1_SERVICES]);
  beforeWaveTwo = await catalogueCounts();

  expect(founding.categories).toHaveLength(FOUNDING_SLUGS.length);
  expect(waveOne.categories).toHaveLength(WAVE_1_GROUPS.length + WAVE_1_SERVICES.length);

  importWave2();
}, 240_000);

afterAll(async () => {
  await ctx.app.close();
});

describe('wave 2 lands next to the founding seven and wave 1', () => {
  it('brings the draft catalogue to ten groups and thirty-two services', async () => {
    const drafts = await ctx.prisma.serviceCategory.findMany({
      where: { status: ServiceCategoryStatus.DRAFT },
      select: { slug: true, kind: true, isActive: true },
      orderBy: { slug: 'asc' },
    });

    const groups = drafts.filter((category) => category.kind === ServiceCategoryKind.GROUP);
    const services = drafts.filter((category) => category.kind === ServiceCategoryKind.LEAF);

    // The P0 total: the two waves' groups and services together.
    expect(groups).toHaveLength(10);
    expect(services).toHaveLength(32);

    expect(groups.map((group) => group.slug)).toEqual(
      [...WAVE_1_GROUPS, ...WAVE_2_GROUPS].sort(),
    );
    expect(services.map((service) => service.slug)).toEqual(
      [...WAVE_1_SERVICES, ...WAVE_2_SLUGS].sort(),
    );

    // status and isActive are the same fact; a draft that is somehow "active"
    // is on the public catalogue whatever its status column says.
    expect(drafts.every((category) => category.isActive === false)).toBe(true);
  });

  it('leaves the seven categories that are on sale exactly as they were', async () => {
    expect(await snapshotOf(FOUNDING_SLUGS)).toEqual(founding);

    const active = await ctx.prisma.serviceCategory.findMany({
      where: { status: ServiceCategoryStatus.ACTIVE },
      select: { slug: true, kind: true },
      orderBy: { slug: 'asc' },
    });

    expect(active.map((category) => category.slug)).toEqual([...FOUNDING_SLUGS].sort());
    expect(active.every((category) => category.kind === ServiceCategoryKind.LEAF)).toBe(true);
  });

  it('leaves wave 1 — including its two shared groups — untouched', async () => {
    // The two groups wave 2 hangs services under are the interesting rows here:
    // adding a child must not rewrite the parent, and `updatedAt` is what says
    // so about every column at once.
    expect(await snapshotOf([...WAVE_1_GROUPS, ...WAVE_1_SERVICES])).toEqual(waveOne);
  });

  it('adds exactly the seventeen services, under the groups they belong to', async () => {
    for (const [slug, expected] of Object.entries(WAVE_2_SERVICES)) {
      const category = await ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { slug },
        include: {
          parent: { select: { slug: true, kind: true, status: true } },
          _count: { select: { questions: true } },
        },
      });

      expect(category.kind, `${slug} tipi`).toBe(ServiceCategoryKind.LEAF);
      expect(category.status, `${slug} durumu`).toBe(ServiceCategoryStatus.DRAFT);
      expect(category.parent?.slug, `${slug} üst grubu`).toBe(expected.parent);
      expect(category.parent?.kind, `${slug} üst grup tipi`).toBe(ServiceCategoryKind.GROUP);
      expect(category._count.questions, `${slug} soru sayısı`).toBe(expected.questions);
    }

    const total = await ctx.prisma.serviceRequestQuestion.count({
      where: { category: { slug: { in: WAVE_2_SLUGS } } },
    });
    expect(total).toBe(WAVE_2_QUESTION_TOTAL);

    // Counted from the other side too: nothing was written onto a group, which
    // has no form to ask a question on.
    const onGroups = await ctx.prisma.serviceRequestQuestion.count({
      where: { category: { slug: { in: WAVE_2_GROUPS } } },
    });
    expect(onGroups).toBe(0);
  });

  it('opens the five new groups as drafts at the top level', async () => {
    for (const slug of WAVE_2_GROUPS) {
      const group = await ctx.prisma.serviceCategory.findUniqueOrThrow({ where: { slug } });

      expect(group.kind, `${slug} tipi`).toBe(ServiceCategoryKind.GROUP);
      expect(group.status, `${slug} durumu`).toBe(ServiceCategoryStatus.DRAFT);
      expect(group.parentId, `${slug} üst kategorisi`).toBeNull();
      // A group takes no request and carries no offer, so it carries no price.
      expect(group.offerCreditCost, `${slug} teklif kredisi`).toBeNull();
    }
  });

  it('prices none of the seventeen, because the research priced none of them', async () => {
    const priced = await ctx.prisma.serviceCategory.findMany({
      where: { slug: { in: WAVE_2_SLUGS }, offerCreditCost: { not: null } },
      select: { slug: true },
    });

    // An invented credit cost would read on the readiness panel as a decision
    // somebody made. NULL reads as the blocker it is.
    expect(priced).toEqual([]);
  });

  it('adds no router, no routing rule and no routing question', async () => {
    const [routers, rules, routerQuestions] = await Promise.all([
      ctx.prisma.serviceCategory.count({ where: { kind: ServiceCategoryKind.ROUTER } }),
      ctx.prisma.serviceCategoryRouterRule.count(),
      ctx.prisma.serviceRequestQuestion.count({ where: { isRouter: true } }),
    ]);

    // Partial routing data would leave a customer on a question that reaches
    // nothing, so routed services are out of this wave entirely.
    expect({ routers, rules, routerQuestions }).toEqual({
      routers: 0,
      rules: 0,
      routerQuestions: 0,
    });
  });
});

describe('the fields wave 2 binds to the request itself', () => {
  it('gives every one of the seventeen a mandatory description, and no second copy of it', async () => {
    const bound = await ctx.prisma.serviceRequestQuestion.findMany({
      where: {
        systemField: ServiceRequestQuestionSystemField.DESCRIPTION,
        category: { slug: { in: WAVE_2_SLUGS } },
      },
      select: { isRequired: true, options: true, category: { select: { slug: true } } },
    });

    expect(bound).toHaveLength(WAVE_2_SLUGS.length);
    expect(bound.every((question) => question.isRequired)).toBe(true);
    // A bound question renders no input of its own, so it has nothing to render
    // options for: it labels a field the request already has.
    expect(bound.every((question) => question.options === null)).toBe(true);
  });

  it('binds the event date to preferredDate on the two services that cannot be priced without one', async () => {
    const bound = await ctx.prisma.serviceRequestQuestion.findMany({
      where: {
        systemField: ServiceRequestQuestionSystemField.PREFERRED_DATE,
        category: { slug: { in: WAVE_2_SLUGS } },
      },
      select: { isRequired: true, type: true, category: { select: { slug: true } } },
      orderBy: { category: { slug: 'asc' } },
    });

    expect(bound.map((question) => question.category.slug)).toEqual([
      'dugun-fotografciligi',
      'etkinlik-yemek-servisi',
    ]);
    expect(bound.every((question) => question.isRequired && question.type === 'DATE')).toBe(true);
  });

  it('binds the budget range to the request’s own budget on the two project services', async () => {
    const bound = await ctx.prisma.serviceRequestQuestion.findMany({
      where: {
        systemField: ServiceRequestQuestionSystemField.BUDGET,
        category: { slug: { in: WAVE_2_SLUGS } },
      },
      select: { isRequired: true, type: true, category: { select: { slug: true } } },
      orderBy: { category: { slug: 'asc' } },
    });

    expect(bound.map((question) => question.category.slug)).toEqual([
      'anahtar-teslim-tadilat',
      'mobil-uygulama-gelistirme',
    ]);
    // The type the binding requires, so the form can render the field it names.
    expect(bound.every((question) => question.isRequired && question.type === 'NUMBER')).toBe(true);
  });

  it('binds no address, because the research verified no form that needed one', async () => {
    const bound = await ctx.prisma.serviceRequestQuestion.count({
      where: {
        systemField: ServiceRequestQuestionSystemField.ADDRESS,
        category: { slug: { in: WAVE_2_SLUGS } },
      },
    });

    expect(bound).toBe(0);
  });

  it('asks for no health detail on the regulated nutrition form', async () => {
    const questions = await ctx.prisma.serviceRequestQuestion.findMany({
      where: { category: { slug: 'beslenme-danismanligi' } },
      select: { key: true, systemField: true, helpText: true },
    });

    // A request is opened to several businesses before one is chosen, and a
    // diagnosis written into it cannot be taken back. The free-text step says
    // so instead of asking for one.
    const description = questions.find((question) => question.systemField === 'DESCRIPTION');
    expect(description?.helpText).toContain('hizmet vereni seçtikten sonra');
    expect(questions.map((question) => question.key)).not.toContain('saglik_durumu');
  });
});

describe('the conditional questions, and only the verified ones', () => {
  it('writes exactly three conditions, all of them on wave 2 services', async () => {
    const conditions = await ctx.prisma.serviceRequestQuestionCondition.findMany({
      select: {
        expectedValues: true,
        matchMode: true,
        question: {
          select: { key: true, sortOrder: true, category: { select: { slug: true } } },
        },
        sourceQuestion: { select: { key: true, sortOrder: true } },
      },
    });

    // One from wave 1's bathroom form, three from wave 2.
    const waveTwo = conditions.filter((condition) =>
      WAVE_2_SLUGS.includes(condition.question.category.slug),
    );

    expect(conditions).toHaveLength(4);
    expect(waveTwo).toHaveLength(3);

    expect(
      waveTwo
        .map((condition) => `${condition.question.category.slug}/${condition.question.key}`)
        .sort(),
    ).toEqual([
      'anahtar-teslim-tadilat/konut_plani',
      'dugun-fotografciligi/dis_cekim_lokasyon',
      'mobil-uygulama-gelistirme/mevcut_uygulama_notu',
    ]);

    for (const condition of waveTwo) {
      // ALL is a distinction only a multi-answer source can carry, and the
      // research verified no case for it in this wave.
      expect(condition.matchMode, `${condition.question.key} eşleşme kipi`).toBe('ANY');
      // The ordering rule that keeps the dependency graph acyclic.
      expect(
        condition.sourceQuestion.sortOrder,
        `${condition.question.key} koşul sırası`,
      ).toBeLessThan(condition.question.sortOrder);
    }
  });

  it('shows the existing-app question on either of the two answers that imply one', async () => {
    const condition = await ctx.prisma.serviceRequestQuestionCondition.findFirstOrThrow({
      where: {
        question: { key: 'mevcut_uygulama_notu', category: { slug: 'mobil-uygulama-gelistirme' } },
      },
      include: { sourceQuestion: true },
    });

    expect(condition.sourceQuestion.key).toBe('proje_durumu');
    expect([...condition.expectedValues].sort()).toEqual(['mevcut_bakim', 'mevcut_gelistirme']);
  });
});

describe('none of the seventeen reaches a caller who is not an operator', () => {
  it('still shows the public exactly the seven categories that are on sale', async () => {
    const response = await request(ctx.server).get('/categories').expect(200);
    const categories = response.body as ListedCategory[];

    expect(categories.map((category) => category.slug).sort()).toEqual([...FOUNDING_SLUGS].sort());
  });

  it('keeps the drafts out of a public search that would otherwise match them', async () => {
    // Each of these words is in a wave 2 name and in none of the seven that are
    // live, so a leak would show up here and nowhere else.
    for (const term of ['danışmanlık', 'ders', 'fotoğraf', 'duşakabin']) {
      const response = await request(ctx.server)
        .get(`/categories?q=${encodeURIComponent(term)}`)
        .expect(200);

      expect(response.body, term).toEqual([]);
    }
  });

  it('answers a guessed wave 2 slug with 404 rather than a 403 that would confirm it', async () => {
    for (const slug of [...WAVE_2_SLUGS, ...WAVE_2_GROUPS]) {
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
        '/categories/beslenme-danismanligi?includeInactive=true',
        '/categories/mobil-uygulama-gelistirme?includeInactive=true',
      ]) {
        const call = request(ctx.server).get(path);
        const response = await (cookie ? call.set('Cookie', cookie) : call).expect(403);

        // Not one slug of the unreleased wave, and not one of its figures,
        // even in the refusal.
        const body = JSON.stringify(response.body);
        for (const slug of WAVE_2_SLUGS) {
          expect(body, `${who} → ${path} (${slug})`).not.toContain(slug);
        }
        expect(body, `${who} → ${path}`).not.toContain('providers');
        expect(body, `${who} → ${path}`).not.toContain('offerCreditCost');
      }
    }
  });

  it('puts no wave 2 name, question or figure on any response the public can read', async () => {
    const listing = await request(ctx.server).get('/categories').expect(200);
    const listingBody = JSON.stringify(listing.body).toLocaleLowerCase('tr-TR');

    const names = await ctx.prisma.serviceCategory.findMany({
      where: { slug: { in: [...WAVE_2_SLUGS, ...WAVE_2_GROUPS] } },
      select: { slug: true, name: true },
    });

    for (const category of names) {
      expect(listingBody, `${category.slug} listede`).not.toContain(category.slug);
      expect(listingBody, `${category.name} listede`).not.toContain(
        category.name.toLocaleLowerCase('tr-TR'),
      );
    }

    // The headcount belongs to the operator's view of a category and to no
    // other, on a live category as much as on a draft one.
    for (const category of listing.body as ListedCategory[]) {
      expect(category._count.providers, `${category.slug}`).toBeUndefined();
    }

    const detail = await request(ctx.server).get('/categories/ev-temizligi').expect(200);
    expect((detail.body as ListedCategory)._count.providers).toBeUndefined();
  });

  it('never names the eligibility review on any API response, operator’s included', async () => {
    /*
     * The regulated-services warning lives in the admin app, as a list of
     * slugs, and this is the assertion that says why that matters: the API
     * carries no such field, so there is nothing for a public response, a
     * provider response or a future serializer to leak. The operator reads the
     * warning on a screen; the wire never says it.
     */
    const responses = [
      await request(ctx.server).get('/categories').expect(200),
      await operatorListing().then((body) => ({ body })),
      await request(ctx.server)
        .get('/categories/beslenme-danismanligi?includeInactive=true')
        .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
        .expect(200),
    ];

    for (const response of responses) {
      const body = JSON.stringify(response.body).toLocaleLowerCase('tr-TR');
      expect(body).not.toContain('uygunluk');
      expect(body).not.toContain('eligibility');
    }
  });
});

describe('the operator’s view of the seventeen', () => {
  it('lists every draft, with the parent, the question count and the missing price', async () => {
    const categories = await operatorListing();

    expect(categories).toHaveLength(
      FOUNDING_SLUGS.length +
        WAVE_1_GROUPS.length +
        WAVE_1_SERVICES.length +
        WAVE_2_GROUPS.length +
        WAVE_2_SLUGS.length,
    );

    for (const [slug, expected] of Object.entries(WAVE_2_SERVICES)) {
      const category = categories.find((candidate) => candidate.slug === slug);

      expect(category, slug).toBeDefined();
      expect(category?.status, `${slug} durumu`).toBe('DRAFT');
      expect(category?.parent?.slug, `${slug} üst grubu`).toBe(expected.parent);
      expect(category?._count.questions, `${slug} soru sayısı`).toBe(expected.questions);
      // The blocker the readiness panel renders: no price, so no offer could
      // ever be made on it.
      expect(category?.offerCreditCost, `${slug} teklif kredisi`).toBeNull();
      expect(category?._count.providers, `${slug} onaylı hizmet veren`).toBe(0);
    }

    for (const slug of WAVE_2_GROUPS) {
      const group = categories.find((candidate) => candidate.slug === slug);
      expect(group?.status, `${slug} durumu`).toBe('DRAFT');
      expect(group?.kind, `${slug} tipi`).toBe('GROUP');
    }
  });

  it('serves the question set of a draft service to a SUPER_ADMIN and to nobody else', async () => {
    const detail = await request(ctx.server)
      .get('/categories/isg-danismanligi?includeInactive=true')
      .set('Cookie', await cookieFor(UserRole.SUPER_ADMIN))
      .expect(200);

    expect(detail.body.status).toBe('DRAFT');
    expect(detail.body.questions).toHaveLength(questionCountOf('isg-danismanligi'));

    await request(ctx.server).get('/categories/isg-danismanligi').expect(404);
  });

  it('lets an operator issue an invitation link for a draft wave 2 service', async () => {
    /*
     * The chicken-and-egg this exists to break: a draft category has no
     * approved provider, and it is invisible to every business that is not
     * already in the system — so supply for it can only be built by inviting
     * somebody. A wave that could not be invited against would be seventeen
     * services nobody could ever staff.
     *
     * Checked on one regulated service and one that is not, because the
     * eligibility warning is a note on a screen and must not have quietly
     * become a rule the API enforces.
     */
    const adminCookie = await cookieFor(UserRole.SUPER_ADMIN);

    for (const slug of ['mobil-uygulama-gelistirme', ...REGULATED_SLUGS]) {
      const category = await ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { slug },
        select: { id: true },
      });

      const response = await request(ctx.server)
        .post(`/categories/${category.id}/provider-invites`)
        .set('Cookie', adminCookie)
        .send({})
        .expect(201);

      expect(response.body.url, slug).toContain('http');
    }

    // A group is a folder: it takes no request, so nobody can be invited to it.
    const group = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { slug: 'kurumsal-ve-danismanlik' },
      select: { id: true },
    });

    await request(ctx.server)
      .post(`/categories/${group.id}/provider-invites`)
      .set('Cookie', adminCookie)
      .send({})
      .expect(409);
  });
});

describe('the second run', () => {
  it('changes no category, question, condition or rule count', async () => {
    const before = await catalogueCounts();

    importWave2();

    expect(await catalogueCounts()).toEqual(before);
  });

  it('adds exactly what the wave says it adds, and nothing else', async () => {
    const after = await catalogueCounts();

    expect(after.categories - beforeWaveTwo.categories).toBe(
      WAVE_2_GROUPS.length + WAVE_2_SLUGS.length,
    );
    expect(after.questions - beforeWaveTwo.questions).toBe(WAVE_2_QUESTION_TOTAL);
    expect(after.conditions - beforeWaveTwo.conditions).toBe(3);
    expect(after.routerRules - beforeWaveTwo.routerRules).toBe(0);
    // No request and no answer row: an import writes catalogue structure and
    // nothing anybody submitted.
    expect(after.requests).toBe(beforeWaveTwo.requests);
    expect(after.answers).toBe(beforeWaveTwo.answers);
  });

  it('still leaves the founding seven and wave 1 alone', async () => {
    expect(await snapshotOf(FOUNDING_SLUGS)).toEqual(founding);
    expect(await snapshotOf([...WAVE_1_GROUPS, ...WAVE_1_SERVICES])).toEqual(waveOne);
  });

  it('does not reopen a category an operator released, or reprice one they priced', async () => {
    // The two decisions the import deliberately does not own. Repricing matters
    // more in this wave than in the last one: every category arrives unpriced,
    // so the first price any of them gets is one a person typed.
    await ctx.prisma.serviceCategory.update({
      where: { slug: 'gitar-dersi' },
      data: { status: ServiceCategoryStatus.ACTIVE, isActive: true, offerCreditCost: 2 },
    });

    importWave2();

    const category = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { slug: 'gitar-dersi' },
    });

    expect(category.status).toBe(ServiceCategoryStatus.ACTIVE);
    expect(category.isActive).toBe(true);
    expect(category.offerCreditCost).toBe(2);

    // Put back, so the file leaves the catalogue in the state it describes.
    await ctx.prisma.serviceCategory.update({
      where: { slug: 'gitar-dersi' },
      data: { status: ServiceCategoryStatus.DRAFT, isActive: false, offerCreditCost: null },
    });
  });
});
