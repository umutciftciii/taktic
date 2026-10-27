import {
  AdminPermission,
  CategoryDeliveryModel,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
  UserRole,
} from '@prisma/client';
import cases from '@taktic/shared/quality-score-cases.json';
import signalCases from '@taktic/shared/quality-signal-cases.json';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countMeaningfulWords,
  qualityTips,
  requestQualityLabel,
  resolveQualitySignals,
  scoreRequestQuality,
  type QualityComponentKey,
  type RequestQualitySignals,
} from '../src/modules/service-requests/request-quality';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createSelectQuestion,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * QUALITY-SCORE-001 — the request quality model.
 *
 * The pure half runs the shared cases file, which the web form's estimate is
 * held to as well: the two calculators agree because both agree with it. The
 * HTTP half proves what only the real flow can — that creation and the admin
 * recalculation read the same form the same way, that a hidden question is
 * never held against the customer, and that a row written by the original
 * model is neither re-labelled with the new thresholds nor moved one click at
 * a time.
 */

const COMPONENTS: QualityComponentKey[] = ['descriptionDepth', 'optionalAnswers', 'budget', 'timing'];

describe('quality calculator — shared cases', () => {
  it.each(cases.words)('counts meaningful words: $name', ({ text, expected }) => {
    expect(countMeaningfulWords(text)).toBe(expected);
  });

  it.each(cases.scores)('scores: $name', ({ signals, expected }) => {
    const result = scoreRequestQuality(signals as RequestQualitySignals);

    expect(result.score).toBe(expected.score);
    expect(result.label).toBe(expected.label);
    for (const key of COMPONENTS) {
      const want = expected.points[key];
      const component = result.breakdown[key];
      if (want === null) {
        expect(component).toMatchObject({ applicable: false, points: 0, max: 0 });
      } else {
        expect(component).toMatchObject({ applicable: true, points: want });
      }
    }
  });

  it.each(cases.scores)('tells the customer what to add: $name', ({ signals, expected }) => {
    const { breakdown, version } = scoreRequestQuality(signals as RequestQualitySignals);
    expect(qualityTips({ qualityScoreVersion: version, qualityScoreBreakdown: breakdown })).toEqual(expected.tips);
  });

  it('carries the decomposed ü of the NFC case as two code points, not a pre-composed one', () => {
    const nfc = cases.words.find((item) => item.name.startsWith('NFC'));
    expect(nfc?.text).toContain('ü');
  });
});

describe('quality signals — shared cases', () => {
  // The web form reads the same scenarios through formQualitySignals
  // (apps/web/test/request-quality-estimate.spec.ts). Question ids equal keys.
  it.each(signalCases.scenarios)('$name', ({ questions, answers, fields, expected }) => {
    const signals = resolveQualitySignals({
      description: fields.description,
      budgetMin: fields.budgetMin ? Number(fields.budgetMin) : null,
      budgetMax: fields.budgetMax ? Number(fields.budgetMax) : null,
      preferredDate: fields.preferredDate || null,
      urgency: fields.urgency || null,
      questions: questions.map((question) => ({
        id: question.id,
        key: question.key,
        type: question.type as ServiceRequestQuestionType,
        sortOrder: question.sortOrder,
        isRequired: question.isRequired,
        systemField: question.systemField as ServiceRequestQuestionSystemField | null,
        conditions: question.conditions.map((condition) => ({
          sourceQuestionId: condition.source,
          expectedValues: condition.expectedValues,
        })),
      })),
      answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
    });
    expect(signals).toEqual({ description: fields.description, ...expected });
  });
});

describe('quality calculator — invariants', () => {
  const base: RequestQualitySignals = {
    description: null,
    hasBudget: false,
    hasDates: false,
    hasUrgency: false,
    budgetRequired: false,
    datesRequired: false,
    optionalVisible: 0,
    optionalAnswered: 0,
  };
  const words = (count: number) =>
    Array.from({ length: count }, (_, index) => `kelime${String.fromCharCode(97 + (index % 26))}${Math.floor(index / 26)}`).join(' ');

  it('reaches 100 under every combination of applicable components', () => {
    for (const optionalVisible of [0, 1, 2, 3, 7]) {
      for (const budgetRequired of [false, true]) {
        for (const datesRequired of [false, true]) {
          const result = scoreRequestQuality({
            ...base,
            description: words(25),
            hasBudget: true,
            hasDates: true,
            budgetRequired,
            datesRequired,
            optionalVisible,
            optionalAnswered: optionalVisible,
          });
          expect(result.score, JSON.stringify({ optionalVisible, budgetRequired, datesRequired })).toBe(100);
        }
      }
    }
  });

  it('stays within 0–100 and never divides by zero', () => {
    for (let count = 0; count <= 40; count += 1) {
      for (const optionalVisible of [0, 1, 3]) {
        for (let optionalAnswered = 0; optionalAnswered <= optionalVisible; optionalAnswered += 1) {
          const result = scoreRequestQuality({
            ...base,
            description: words(count),
            budgetRequired: true,
            datesRequired: true,
            optionalVisible,
            optionalAnswered,
          });
          expect(Number.isInteger(result.score)).toBe(true);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('is linear in meaningful words up to 25 and flat after', () => {
    const points = [0, 1, 5, 10, 13, 24, 25, 26, 100].map(
      (count) => scoreRequestQuality({ ...base, description: words(count) }).breakdown.descriptionDepth.points,
    );
    expect(points).toEqual([0, 2, 8, 16, 21, 38, 40, 40, 40]);
  });

  it('weighs optional questions 10 for one or two visible and 20 from three', () => {
    const max = (optionalVisible: number) =>
      scoreRequestQuality({ ...base, optionalVisible }).breakdown.optionalAnswers.max;
    expect([max(1), max(2), max(3), max(9)]).toEqual([10, 10, 20, 20]);
  });

  it('is deterministic: the same signals give the same result', () => {
    const signals = { ...base, description: words(9), hasUrgency: true, optionalVisible: 3, optionalAnswered: 1 };
    expect(scoreRequestQuality(signals)).toEqual(scoreRequestQuality({ ...signals }));
  });

  it('labels an original-model row with the original thresholds and a current row with the gate', () => {
    expect(requestQualityLabel({ qualityScore: 80, qualityScoreVersion: 1, qualityScoreBreakdown: null })).toBe('HIGH');
    expect(requestQualityLabel({ qualityScore: 75, qualityScoreVersion: 1, qualityScoreBreakdown: null })).toBe('MEDIUM');
    expect(requestQualityLabel({ qualityScore: 49, qualityScoreVersion: 1, qualityScoreBreakdown: null })).toBe('LOW');

    const words = (meaningfulWords: number) => ({ descriptionDepth: { meaningfulWords } });
    expect(requestQualityLabel({ qualityScore: 75, qualityScoreVersion: 2, qualityScoreBreakdown: words(12) })).toBe('HIGH');
    expect(requestQualityLabel({ qualityScore: 75, qualityScoreVersion: 2, qualityScoreBreakdown: words(4) })).toBe('LOW');
    expect(requestQualityLabel({ qualityScore: 40, qualityScoreVersion: 2, qualityScoreBreakdown: words(5) })).toBe('MEDIUM');
    // A current row that cannot explain its word count is not trusted with a better label.
    expect(requestQualityLabel({ qualityScore: 90, qualityScoreVersion: 2, qualityScoreBreakdown: null })).toBe('LOW');
  });
});

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

const DESCRIPTION_25 =
  'Salon kliması soğutmuyor, dış ünite yüksek ses yapıyor. Cihaz beş yıllık, inverter model; filtreler geçen ay ' +
  'temizlendi, gaz kaçağından şüpheleniyoruz. Hafta içi akşam saatlerinde evdeyiz, apartman otoparkı ziyaretçiye açık.';

/** Two Istanbul calendar days from now, as the form posts them. */
function futureRange() {
  const day = (offset: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(Date.now() + offset * 86_400_000));
  return { preferredDate: day(3), preferredDateEnd: day(5), urgency: 'FLEXIBLE' };
}

async function recalcCookie() {
  const { admin } = await createAdminWithPermissions(ctx.prisma, [
    AdminPermission.REQUESTS_READ,
    AdminPermission.REQUESTS_QUALITY_RECALC,
  ]);
  return loginAs(ctx.prisma, admin.id);
}

/**
 * The quality the API stored. The create response is the customer's and
 * carries only the label and tips (QUALITY-SCORE-001), so the number, the
 * version and the breakdown are read where the business and the operator
 * read them: the row.
 */
async function quality(id: string) {
  const row = await stored(id);
  return {
    score: row.qualityScore,
    version: row.qualityScoreVersion,
    breakdown: row.qualityScoreBreakdown as Record<string, Record<string, unknown>>,
  };
}

async function stored(id: string) {
  return ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id },
    select: { qualityScore: true, qualityScoreBreakdown: true, qualityScoreVersion: true },
  });
}

describe('quality on a created request', () => {
  it('is written by the current model, with the four components and nothing mandatory', async () => {
    expect(countMeaningfulWords(DESCRIPTION_25)).toBeGreaterThanOrEqual(25);
    const category = await createCategory(ctx.prisma, 'Kalite tam', { offerCreditCost: 1 });

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description: DESCRIPTION_25,
          budgetMin: 150_000,
          budgetMax: 250_000,
          ...futureRange(),
        }),
      )
      .expect(201);

    const written = await quality(created.body.id);
    expect(written.score).toBe(100);
    expect(created.body.qualityLabel).toBe('HIGH');
    expect(written.version).toBe(2);
    expect(Object.keys(written.breakdown).sort()).toEqual([...COMPONENTS].sort());
    // A category without optional questions takes that row out of the denominator.
    expect(written.breakdown.optionalAnswers).toMatchObject({
      applicable: false,
      notApplicableReason: 'NO_VISIBLE_OPTIONAL_QUESTIONS',
    });
  });

  it('gives the same score whatever the mandatory and non-scored fields hold', async () => {
    const category = await createCategory(ctx.prisma, 'Zorunlu alan', { offerCreditCost: 1 });
    const description = 'Mutfak lavabosu sızdırıyor, dolabın altı ıslak.';

    const bare = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description }))
      .expect(201);
    const dressed = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description,
          addressNote: 'Üçüncü kat, asansör var, otopark bahçede; zil çalışmıyor.',
          neighborhood: bare.body.neighborhood,
        }),
      )
      .expect(201);

    expect(await quality(dressed.body.id)).toEqual(await quality(bare.body.id));
  });

  it('scores an ON_SITE and a REMOTE request with the same content the same', async () => {
    const onSite = await createCategory(ctx.prisma, 'Yerinde', { offerCreditCost: 1 });
    const remote = await createCategory(ctx.prisma, 'Uzaktan', {
      offerCreditCost: 1,
      deliveryModel: CategoryDeliveryModel.REMOTE,
    });
    const body = { description: DESCRIPTION_25, budgetMin: 100_000 };

    const a = await request(ctx.server).post('/service-requests').send(serviceRequestPayload(onSite.slug, body)).expect(201);
    const b = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(remote.slug, { ...body, neighborhood: null }))
      .expect(201);

    expect(b.body.deliveryMode).toBe('REMOTE');
    expect(await quality(b.body.id)).toEqual(await quality(a.body.id));
  });

  it('caps the label of a near-empty description at LOW and keeps the number', async () => {
    const category = await createCategory(ctx.prisma, 'Kapı', { offerCreditCost: 1 });

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description: 'Klima bozuk.',
          budgetMin: 100_000,
          ...futureRange(),
        }),
      )
      .expect(201);

    const written = await quality(created.body.id);
    expect(written.breakdown.descriptionDepth?.meaningfulWords).toBe(2);
    expect(written.score).toBe(47);
    expect(created.body.qualityLabel).toBe('LOW');
    // The customer is told what to add; the business still sees the number.
    expect(created.body.qualityTips).toEqual(['DESCRIPTION']);
  });

  it('counts only the optional questions the customer could see', async () => {
    const category = await createCategory(ctx.prisma, 'Koşullu', { offerCreditCost: 1 });
    const trigger = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'ek_is',
      options: [
        { key: 'evet', label: 'Evet' },
        { key: 'hayir', label: 'Hayır' },
      ],
      sortOrder: 1,
    });
    const hiddenOptional = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'ek_detay',
      options: [{ key: 'a', label: 'A' }],
      sortOrder: 2,
    });
    const hiddenRequired = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'ek_zorunlu',
      options: [{ key: 'a', label: 'A' }],
      isRequired: true,
      sortOrder: 3,
    });
    for (const question of [hiddenOptional, hiddenRequired]) {
      await ctx.prisma.serviceRequestQuestionCondition.create({
        data: { questionId: question.id, sourceQuestionId: trigger.id, expectedValues: ['evet'] },
      });
    }

    const answeredNo = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { answers: [{ questionKey: 'ek_is', value: 'hayir' }] }))
      .expect(201);

    // One visible optional question, answered: the hidden optional one is not
    // in the denominator and the hidden required one costs nothing.
    expect((await quality(answeredNo.body.id)).breakdown.optionalAnswers).toMatchObject({
      applicable: true,
      visible: 1,
      answered: 1,
      max: 10,
      points: 10,
    });

    const unanswered = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);
    expect((await quality(unanswered.body.id)).breakdown.optionalAnswers).toMatchObject({
      visible: 1,
      answered: 0,
      points: 0,
    });
  });

  it('takes a required bound field out of the denominator and never counts a bound question as optional', async () => {
    const category = await createCategory(ctx.prisma, 'Bağlı alan', { offerCreditCost: 1 });
    const bound = (key: string, systemField: ServiceRequestQuestionSystemField, isRequired: boolean, type: ServiceRequestQuestionType) =>
      ctx.prisma.serviceRequestQuestion.create({
        data: { categoryId: category.id, key, label: key, type, isRequired, systemField, isActive: true, sortOrder: 0 },
      });
    await bound('butce', ServiceRequestQuestionSystemField.BUDGET, true, ServiceRequestQuestionType.NUMBER);
    // Optional and bound: the date row stays applicable, and it is not an optional question.
    await bound('tarih', ServiceRequestQuestionSystemField.PREFERRED_DATE, false, ServiceRequestQuestionType.DATE);

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMin: 100_000 }))
      .expect(201);

    const { breakdown } = await quality(created.body.id);
    expect(breakdown.budget).toMatchObject({ applicable: false, notApplicableReason: 'REQUIRED_FIELD' });
    expect(breakdown.timing).toMatchObject({ applicable: true, basis: 'NONE' });
    expect(breakdown.optionalAnswers).toMatchObject({ applicable: false });
  });
});

describe("the customer's view", () => {
  it('never carries the number, the version or the working — only the label and the tips', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const category = await createCategory(ctx.prisma, 'Müşteri görünümü', { offerCreditCost: 1 });

    const created = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug, { description: DESCRIPTION_25, urgency: 'FLEXIBLE' }))
      .expect(201);
    const list = await request(ctx.server).get('/service-requests/my').set('Cookie', cookie).expect(200);
    const detail = await request(ctx.server)
      .get(`/service-requests/my/${created.body.id}`)
      .set('Cookie', cookie)
      .expect(200);

    for (const body of [created.body, list.body[0], detail.body]) {
      expect(body).not.toHaveProperty('qualityScore');
      expect(body).not.toHaveProperty('qualityScoreVersion');
      expect(body).not.toHaveProperty('qualityScoreBreakdown');
      // 25+ words, no budget, urgency only: 48/70.
      expect(body.qualityLabel).toBe('MEDIUM');
      expect(body.qualityTips).toEqual(['BUDGET', 'TIMING']);
    }
    // The number is still there for the business and the operator.
    expect((await quality(created.body.id)).score).toBe(69);
  });

  it('gives an original-model row its label and no tips', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const category = await createCategory(ctx.prisma, 'Eski müşteri', { offerCreditCost: 1 });
    const legacy = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id });

    const detail = await request(ctx.server)
      .get(`/service-requests/my/${legacy.id}`)
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .expect(200);

    expect(detail.body.qualityLabel).toBe('HIGH');
    expect(detail.body.qualityTips).toEqual([]);
    expect(detail.body).not.toHaveProperty('qualityScore');
  });
});

describe('admin recalculation', () => {
  it('reproduces the created score and breakdown exactly — one calculator, one form', async () => {
    const category = await createCategory(ctx.prisma, 'Parite', { offerCreditCost: 1 });
    await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'aciklama',
        label: 'Açıklama',
        type: ServiceRequestQuestionType.TEXTAREA,
        isRequired: true,
        systemField: ServiceRequestQuestionSystemField.DESCRIPTION,
        isActive: true,
        sortOrder: 0,
      },
    });
    const trigger = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'kat',
      options: [
        { key: 'zemin', label: 'Zemin' },
        { key: 'ust', label: 'Üst' },
      ],
      sortOrder: 1,
    });
    const dependent = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'asansor',
      options: [{ key: 'var', label: 'Var' }],
      isRequired: true,
      sortOrder: 2,
    });
    await ctx.prisma.serviceRequestQuestionCondition.create({
      data: { questionId: dependent.id, sourceQuestionId: trigger.id, expectedValues: ['ust'] },
    });

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description: 'Banyo fayansları değişecek, yaklaşık sekiz metrekare alan.',
          answers: [{ questionKey: 'kat', value: 'zemin' }],
        }),
      )
      .expect(201);
    const before = await stored(created.body.id);

    const recalculated = await request(ctx.server)
      .post(`/service-requests/${created.body.id}/recalculate-quality`)
      .set('Cookie', await recalcCookie())
      .expect(201);

    // Before this model the bound DESCRIPTION question cost 10 points here.
    expect(recalculated.body.qualityScore).toBe(before.qualityScore);
    expect(await stored(created.body.id)).toEqual(before);
  });

  it('refuses an original-model row and leaves it untouched', async () => {
    const category = await createCategory(ctx.prisma, 'Eski model', { offerCreditCost: 1 });
    const legacy = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const before = await stored(legacy.id);
    expect(before.qualityScoreVersion).toBe(1);

    const refused = await request(ctx.server)
      .post(`/service-requests/${legacy.id}/recalculate-quality`)
      .set('Cookie', await recalcCookie())
      .expect(409);

    expect(refused.body.code).toBe('QUALITY_SCORE_BACKFILL_PENDING');
    expect(await stored(legacy.id)).toEqual(before);
  });
});

describe('provider request feed', () => {
  it('ranks a current-model request above an original-model one with a bigger number', async () => {
    const category = await createCategory(ctx.prisma, 'Akış', { offerCreditCost: 1 });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, user.id);

    const legacy = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const current = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    await ctx.prisma.serviceRequest.update({
      where: { id: current.id },
      data: {
        qualityScore: 55,
        qualityScoreVersion: 2,
        qualityScoreBreakdown: { descriptionDepth: { points: 24, max: 40, passed: false, applicable: true, meaningfulWords: 15 } },
      },
    });

    const listed = await request(ctx.server).get(`/providers/${provider.id}/requests`).set('Cookie', cookie).expect(200);
    const rows = listed.body.map((row: { id: string; qualityScore: number; qualityLabel: string }) => [
      row.id,
      row.qualityScore,
      row.qualityLabel,
    ]);

    expect(rows).toEqual([
      [current.id, 55, 'MEDIUM'],
      [legacy.id, 80, 'HIGH'],
    ]);

    // The label filter reads each row with its own model's thresholds.
    const high = await request(ctx.server)
      .get(`/providers/${provider.id}/requests?qualityLabel=HIGH`)
      .set('Cookie', cookie)
      .expect(200);
    expect(high.body.map((row: { id: string }) => row.id)).toEqual([legacy.id]);
  });

  it('filters by "at least this label" and refuses the retired numeric minimum outright', async () => {
    const category = await createCategory(ctx.prisma, 'Etiket filtresi', { offerCreditCost: 1 });
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId: category.id });
    const cookie = await loginAs(ctx.prisma, user.id);
    const write = async (qualityScore: number, meaningfulWords: number) => {
      const row = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
      await ctx.prisma.serviceRequest.update({
        where: { id: row.id },
        data: {
          qualityScore,
          qualityScoreVersion: 2,
          qualityScoreBreakdown: { descriptionDepth: { points: 0, max: 40, passed: false, applicable: true, meaningfulWords } },
        },
      });
      return row.id;
    };
    const high = await write(85, 20);
    const medium = await write(50, 12);
    const low = await write(30, 12);
    const gated = await write(75, 3);

    const list = async (query: string) =>
      (await request(ctx.server).get(`/providers/${provider.id}/requests${query}`).set('Cookie', cookie).expect(200))
        .body.map((row: { id: string }) => row.id)
        .sort();

    expect(await list('?minQualityLabel=MEDIUM')).toEqual([high, medium].sort());
    expect(await list('?minQualityLabel=HIGH')).toEqual([high]);
    expect(await list('?minQualityLabel=LOW')).toEqual([high, medium, low, gated].sort());

    // A bookmarked numeric filter is not quietly turned into a label.
    const refused = await request(ctx.server)
      .get(`/providers/${provider.id}/requests?minQualityScore=60`)
      .set('Cookie', cookie)
      .expect(400);
    expect(refused.body.code).toBe('QUALITY_SCORE_FILTER_RETIRED');
  });
});
