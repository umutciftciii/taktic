import {
  QuestionConditionMatchMode,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createDiscoverableProvider,
  createSelectQuestion,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';
import { listNeighborhoods } from '../src/modules/locations/turkey-locations';

/**
 * The category expansion, end to end through the API: the taxonomy's access
 * matrix, parent/child integrity, conditional questions, routed flows and the
 * entry-versus-final category split.
 *
 * Everything here goes through HTTP, with the production guards and the
 * production ValidationPipe in place, because the claims are about what a
 * client may do — not about what a service method returns when called directly.
 */

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

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('public catalogue', () => {
  it('lists ACTIVE leaves and nothing else', async () => {
    const leaf = await createCategory(ctx.prisma, 'Aktif hizmet', { offerCreditCost: 1 });
    const draft = await createCategory(ctx.prisma, 'Taslak hizmet', {
      status: ServiceCategoryStatus.DRAFT,
    });
    const closed = await createCategory(ctx.prisma, 'Kapalı hizmet', {
      status: ServiceCategoryStatus.INACTIVE,
    });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
    });
    const router = await createCategory(ctx.prisma, 'Yönlendirici', {
      kind: ServiceCategoryKind.ROUTER,
    });

    const response = await request(ctx.server).get('/categories').expect(200);
    const slugs = response.body.map((category: { slug: string }) => category.slug);

    expect(slugs).toContain(leaf.slug);
    expect(slugs).not.toContain(draft.slug);
    expect(slugs).not.toContain(closed.slug);
    expect(slugs).not.toContain(group.slug);
    expect(slugs).not.toContain(router.slug);
  });

  it('hides a draft category behind a 404 rather than a 403', async () => {
    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
    });

    // 403 would confirm the slug of an unreleased service to anybody who
    // guessed it.
    await request(ctx.server).get(`/categories/${draft.slug}`).expect(404);
  });

  it('serves an ACTIVE router by slug so a routed flow can start', async () => {
    const router = await createCategory(ctx.prisma, 'Yönlendirici', {
      kind: ServiceCategoryKind.ROUTER,
    });

    const response = await request(ctx.server).get(`/categories/${router.slug}`).expect(200);
    expect(response.body.kind).toBe(ServiceCategoryKind.ROUTER);
  });

  it('still returns the whole tree to an admin, with kind and status', async () => {
    await createCategory(ctx.prisma, 'Taslak', { status: ServiceCategoryStatus.DRAFT });
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .get('/categories?includeInactive=true')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.length).toBe(1);
    expect(response.body[0]).toMatchObject({
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.DRAFT,
      // The pre-taxonomy boolean is still there and still agrees.
      isActive: false,
    });
  });
});

describe('request access matrix', () => {
  it('accepts a request on an ACTIVE leaf', async () => {
    const category = await createCategory(ctx.prisma, 'Aktif', { offerCreditCost: 1 });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    expect(response.body.categoryId).toBe(category.id);
    // Unrouted: the entry *was* the category, which is what NULL records.
    expect(response.body.entryCategoryId ?? null).toBeNull();
  });

  it('refuses a draft category to the public and allows it to an admin', async () => {
    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 1,
    });

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(draft.slug))
      .expect(404);

    const cookie = await adminCookie();
    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(draft.slug))
      .expect(201);
  });

  it('refuses a closed category to everyone, admin included', async () => {
    const closed = await createCategory(ctx.prisma, 'Kapalı', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 1,
    });
    const cookie = await adminCookie();

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(closed.slug))
      .expect(404);

    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(closed.slug))
      .expect(404);
  });

  it('refuses a group category with a message that says what to do instead', async () => {
    const group = await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(group.slug))
      .expect(400);

    expect(response.body.message).toContain('hizmet');
  });

  it('refuses a router that has not been answered yet', async () => {
    const { router } = await routerFixture();

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(router.slug))
      .expect(400);

    expect(response.body.message).toContain('Yönlendirme tamamlanmadı');
  });
});

describe('category tree integrity', () => {
  it('refuses to delete a parent that still has children', async () => {
    const cookie = await adminCookie();
    const parent = await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });
    await createCategory(ctx.prisma, 'Çocuk', { parentId: parent.id, offerCreditCost: 1 });

    const response = await request(ctx.server)
      .delete(`/categories/${parent.id}`)
      .set('Cookie', cookie)
      .expect(409);

    expect(response.body.message).toContain('alt kategori');
    expect(await ctx.prisma.serviceCategory.count({ where: { id: parent.id } })).toBe(1);
  });

  it('deletes a leaf nothing points at', async () => {
    const cookie = await adminCookie();
    const orphan = await createCategory(ctx.prisma, 'Kullanılmamış', { offerCreditCost: 1 });

    await request(ctx.server)
      .delete(`/categories/${orphan.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(await ctx.prisma.serviceCategory.count({ where: { id: orphan.id } })).toBe(0);
  });

  it('refuses to delete a category that carries requests', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Kullanılan', { offerCreditCost: 1 });
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    const response = await request(ctx.server)
      .delete(`/categories/${category.id}`)
      .set('Cookie', cookie)
      .expect(409);

    expect(response.body.message).toContain('kapatın');
  });

  it('refuses a parent that is not a group', async () => {
    const cookie = await adminCookie();
    const leaf = await createCategory(ctx.prisma, 'Hizmet', { offerCreditCost: 1 });

    await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({
        name: 'Alt hizmet',
        slug: 'alt-hizmet',
        offerCreditCost: 1,
        parentId: leaf.id,
      })
      .expect(400);
  });

  it('refuses to move a group under its own descendant', async () => {
    const cookie = await adminCookie();
    const root = await createCategory(ctx.prisma, 'Kök', { kind: ServiceCategoryKind.GROUP });
    const child = await createCategory(ctx.prisma, 'Alt', {
      kind: ServiceCategoryKind.GROUP,
      parentId: root.id,
    });

    const response = await request(ctx.server)
      .patch(`/categories/${root.id}`)
      .set('Cookie', cookie)
      .send({ parentId: child.id })
      .expect(400);

    expect(response.body.message).toContain('alt ağac');
  });

  it('refuses to turn a category that already carries requests into a router', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Kullanılan', { offerCreditCost: 1 });
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(201);

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', cookie)
      .send({ kind: ServiceCategoryKind.ROUTER })
      .expect(409);
  });
});

describe('conditional questions', () => {
  /**
   * A category whose second question only applies to one answer of the first —
   * the shape the expansion's bathroom-renovation form uses.
   */
  async function conditionalFixture() {
    const category = await createCategory(ctx.prisma, 'Banyo', { offerCreditCost: 1 });
    const source = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'tadilat_tipi',
      sortOrder: 10,
      isRequired: true,
      options: [
        { key: 'komple', label: 'Komple yenileme' },
        { key: 'fayans', label: 'Fayans' },
      ],
    });
    const dependent = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'yapilacak_isler',
      sortOrder: 20,
      isRequired: true,
      multi: true,
      options: [
        { key: 'tesisat', label: 'Tesisat' },
        { key: 'dolap', label: 'Dolap' },
      ],
    });

    await ctx.prisma.serviceRequestQuestionCondition.create({
      data: {
        questionId: dependent.id,
        sourceQuestionId: source.id,
        expectedValues: ['komple'],
      },
    });

    return { category, source, dependent };
  }

  it('does not demand a required question that is not applicable', async () => {
    const { category } = await conditionalFixture();

    // `fayans` hides the dependent question, so leaving it out is complete.
    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'tadilat_tipi', value: 'fayans' }],
        }),
      )
      .expect(201);
  });

  it('demands it once the trigger answer is given', async () => {
    const { category } = await conditionalFixture();

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'tadilat_tipi', value: 'komple' }],
        }),
      )
      .expect(400);

    expect(response.body.message).toContain('yapilacak_isler');
  });

  it('refuses an answer to a question the conditions keep off screen', async () => {
    const { category } = await conditionalFixture();

    // The browser hides it; a client that answers anyway is refused here. The
    // API never trusts the form about what was on screen.
    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [
            { questionKey: 'tadilat_tipi', value: 'fayans' },
            { questionKey: 'yapilacak_isler', value: ['tesisat'] },
          ],
        }),
      )
      .expect(400);

    expect(response.body.message).toContain('görünmüyor');
  });

  it('stores the dependent answer when the question really was on screen', async () => {
    const { category } = await conditionalFixture();

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [
            { questionKey: 'tadilat_tipi', value: 'komple' },
            { questionKey: 'yapilacak_isler', value: ['tesisat', 'dolap'] },
          ],
        }),
      )
      .expect(201);

    const answers = await ctx.prisma.serviceRequestAnswer.findMany({
      where: { requestId: response.body.id },
      orderBy: { questionKey: 'asc' },
    });

    expect(answers.map((answer) => answer.questionKey)).toEqual([
      'tadilat_tipi',
      'yapilacak_isler',
    ]);
  });

  it('refuses a rule whose source sorts after its target', async () => {
    const cookie = await adminCookie();
    const { source, dependent } = await conditionalFixture();

    // The ordering rule is what makes the dependency graph acyclic by
    // construction; without it the visibility pass would need a cycle search.
    const response = await request(ctx.server)
      .put(`/questions/${source.id}/conditions`)
      .set('Cookie', cookie)
      .send({ conditions: [{ sourceQuestionKey: dependent.key, expectedValues: ['tesisat'] }] })
      .expect(400);

    expect(response.body.message).toContain('önce sıralanmalı');
  });

  it('refuses a rule that names another category’s question', async () => {
    const cookie = await adminCookie();
    const { dependent } = await conditionalFixture();

    const other = await createCategory(ctx.prisma, 'Başka', { offerCreditCost: 1 });
    await createSelectQuestion(ctx.prisma, {
      categoryId: other.id,
      key: 'yabanci_soru',
      sortOrder: 1,
      options: [{ key: 'evet', label: 'Evet' }],
    });

    const response = await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({ conditions: [{ sourceQuestionKey: 'yabanci_soru', expectedValues: ['evet'] }] })
      .expect(400);

    expect(response.body.message).toContain('bu kategoride yok');
  });

  it('refuses an expected value the source question does not offer', async () => {
    const cookie = await adminCookie();
    const { dependent, source } = await conditionalFixture();

    await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({ conditions: [{ sourceQuestionKey: source.key, expectedValues: ['olmayan'] }] })
      .expect(400);
  });
});

describe('system field bindings', () => {
  async function boundFixture(
    systemField: ServiceRequestQuestionSystemField,
    type: ServiceRequestQuestionType,
  ) {
    const category = await createCategory(ctx.prisma, 'Bağlı', { offerCreditCost: 1 });
    const question = await ctx.prisma.serviceRequestQuestion.create({
      data: {
        categoryId: category.id,
        key: 'bagli_soru',
        label: 'Bağlı soru',
        type,
        isRequired: true,
        systemField,
        sortOrder: 10,
        isActive: true,
      },
    });

    return { category, question };
  }

  it('requires the description when a DESCRIPTION binding is required', async () => {
    const { category } = await boundFixture(
      ServiceRequestQuestionSystemField.DESCRIPTION,
      ServiceRequestQuestionType.TEXTAREA,
    );

    const refused = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: null }))
      .expect(400);
    expect(refused.body.message).toContain('iş açıklaması');

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: 'Banyo yenilenecek' }))
      .expect(201);
  });

  it('requires a budget when a BUDGET binding is required', async () => {
    const { category } = await boundFixture(
      ServiceRequestQuestionSystemField.BUDGET,
      ServiceRequestQuestionType.NUMBER,
    );

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(400);

    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { budgetMax: 500_00 }))
      .expect(201);
  });

  it('requires the neighbourhood when an ADDRESS binding is required', async () => {
    const { category } = await boundFixture(
      ServiceRequestQuestionSystemField.ADDRESS,
      ServiceRequestQuestionType.TEXT,
    );

    // City and district are already mandatory on every request, so a required
    // ADDRESS binding is asking for the level the base form leaves optional.
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug))
      .expect(400);

    // From the same canonical dataset the endpoint validates against, so this
    // case cannot fail on a spelling the location validator does not know.
    const [neighborhood] = listNeighborhoods('İstanbul', 'Kadıköy');
    await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { neighborhood }))
      .expect(201);
  });

  it('never writes the bound value a second time into the answers', async () => {
    const { category } = await boundFixture(
      ServiceRequestQuestionSystemField.DESCRIPTION,
      ServiceRequestQuestionType.TEXTAREA,
    );

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { description: 'Banyo yenilenecek' }))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { answers: true },
    });

    expect(stored.description).toBe('Banyo yenilenecek');
    // The whole point of a binding: one place holds the value.
    expect(stored.answers).toHaveLength(0);
  });

  it('refuses an answer sent for a bound question', async () => {
    const { category } = await boundFixture(
      ServiceRequestQuestionSystemField.DESCRIPTION,
      ServiceRequestQuestionType.TEXTAREA,
    );

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          description: 'Banyo yenilenecek',
          answers: [{ questionKey: 'bagli_soru', value: 'ikinci kopya' }],
        }),
      )
      .expect(400);

    expect(response.body.message).toContain('cevap olarak gönderilemez');
  });

  it('refuses a binding on a question type that could not carry it', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Bağlı', { offerCreditCost: 1 });

    await request(ctx.server)
      .post(`/categories/${category.id}/questions`)
      .set('Cookie', cookie)
      .send({
        key: 'yanlis_tip',
        label: 'Yanlış tip',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 10,
        options: [{ key: 'a', label: 'A' }],
        systemField: ServiceRequestQuestionSystemField.BUDGET,
      })
      .expect(400);
  });
});

/**
 * A one-stage router: "hangi cihaz?" → the appliance's own category.
 */
async function routerFixture() {
  const washer = await createCategory(ctx.prisma, 'Çamaşır makinesi', { offerCreditCost: 2 });
  const dishwasher = await createCategory(ctx.prisma, 'Bulaşık makinesi', { offerCreditCost: 2 });
  const router = await createCategory(ctx.prisma, 'Beyaz eşya servisi', {
    kind: ServiceCategoryKind.ROUTER,
  });

  const question = await createSelectQuestion(ctx.prisma, {
    categoryId: router.id,
    key: 'cihaz',
    label: 'Hangi cihaz?',
    sortOrder: 10,
    isRequired: true,
    isRouter: true,
    options: [
      { key: 'camasir', label: 'Çamaşır makinesi' },
      { key: 'bulasik', label: 'Bulaşık makinesi' },
    ],
  });

  await ctx.prisma.serviceCategoryRouterRule.createMany({
    data: [
      { questionId: question.id, optionKey: 'camasir', targetCategoryId: washer.id },
      { questionId: question.id, optionKey: 'bulasik', targetCategoryId: dishwasher.id },
    ],
  });

  return { router, question, washer, dishwasher };
}

describe('routing', () => {
  it('resolves an option to its leaf', async () => {
    const { router, washer } = await routerFixture();

    const response = await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: router.slug,
        selections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
      })
      .expect(201);

    expect(response.body).toMatchObject({
      entryCategorySlug: router.slug,
      categorySlug: washer.slug,
      kind: ServiceCategoryKind.LEAF,
      isFinal: true,
      pendingRouterQuestionKey: null,
    });
  });

  it('names the next question when the walk has not finished', async () => {
    const { router } = await routerFixture();

    const response = await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({ entryCategorySlug: router.slug, selections: [] })
      .expect(201);

    expect(response.body.isFinal).toBe(false);
    expect(response.body.pendingRouterQuestionKey).toBe('cihaz');
  });

  it('refuses an option the routing question does not offer', async () => {
    const { router } = await routerFixture();

    await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: router.slug,
        selections: [{ questionKey: 'cihaz', optionKey: 'uydurma' }],
      })
      .expect(400);
  });

  it('refuses a selection aimed at the wrong question', async () => {
    const { router } = await routerFixture();

    await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: router.slug,
        selections: [{ questionKey: 'baska_soru', optionKey: 'camasir' }],
      })
      .expect(400);
  });

  it('answers a closed destination with a 409 that names the reason', async () => {
    const { router, washer } = await routerFixture();
    await ctx.prisma.serviceCategory.update({
      where: { id: washer.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const response = await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: router.slug,
        selections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
      })
      .expect(409);

    // A 404 would be wrong: the category the customer chose is fine, the
    // destination behind their answer is not.
    expect(response.body.code).toBe('ROUTER_TARGET_UNAVAILABLE');
  });

  it('walks two stages', async () => {
    const { router: inner, washer } = await routerFixture();
    const outer = await createCategory(ctx.prisma, 'Teknik servis', {
      kind: ServiceCategoryKind.ROUTER,
    });
    const outerQuestion = await createSelectQuestion(ctx.prisma, {
      categoryId: outer.id,
      key: 'alan',
      sortOrder: 10,
      isRequired: true,
      isRouter: true,
      options: [{ key: 'beyaz_esya', label: 'Beyaz eşya' }],
    });
    await ctx.prisma.serviceCategoryRouterRule.create({
      data: {
        questionId: outerQuestion.id,
        optionKey: 'beyaz_esya',
        targetCategoryId: inner.id,
      },
    });

    const halfway = await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: outer.slug,
        selections: [{ questionKey: 'alan', optionKey: 'beyaz_esya' }],
      })
      .expect(201);

    expect(halfway.body).toMatchObject({
      categorySlug: inner.slug,
      kind: ServiceCategoryKind.ROUTER,
      isFinal: false,
      pendingRouterQuestionKey: 'cihaz',
    });

    const finished = await request(ctx.server)
      .post('/categories/routing/resolve')
      .send({
        entryCategorySlug: outer.slug,
        selections: [
          { questionKey: 'alan', optionKey: 'beyaz_esya' },
          { questionKey: 'cihaz', optionKey: 'camasir' },
        ],
      })
      .expect(201);

    expect(finished.body).toMatchObject({ categorySlug: washer.slug, isFinal: true });
  });

  it('keeps the entry and the final category apart on the request', async () => {
    const { router, washer } = await routerFixture();

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(router.slug, {
          routerSelections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
        }),
      )
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { answers: true },
    });

    // Everything downstream — matching, pricing, scope — reads `categoryId`.
    expect(stored.categoryId).toBe(washer.id);
    expect(stored.entryCategoryId).toBe(router.id);

    // The routing choice is stored as the answer it is, so the provider who
    // prices the request can see what put it in front of them.
    expect(stored.answers.map((answer) => [answer.questionKey, answer.value])).toEqual([
      ['cihaz', 'camasir'],
    ]);
  });

  it('refuses a request whose route leads to a closed leaf', async () => {
    const { router, washer } = await routerFixture();
    await ctx.prisma.serviceCategory.update({
      where: { id: washer.id },
      data: { status: ServiceCategoryStatus.INACTIVE, isActive: false },
    });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(router.slug, {
          routerSelections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
        }),
      )
      .expect(409);

    expect(response.body.code).toBe('ROUTER_TARGET_UNAVAILABLE');
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('validates the leaf’s own questions after routing, not the router’s', async () => {
    const { router, washer } = await routerFixture();
    await createSelectQuestion(ctx.prisma, {
      categoryId: washer.id,
      key: 'ariza',
      sortOrder: 10,
      isRequired: true,
      options: [{ key: 'calismiyor', label: 'Çalışmıyor' }],
    });

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(router.slug, {
          routerSelections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
        }),
      )
      .expect(400);

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(router.slug, {
          routerSelections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
          answers: [{ questionKey: 'ariza', value: 'calismiyor' }],
        }),
      )
      .expect(201);
  });

  it('refuses a routing rule on a category that is not a router', async () => {
    const cookie = await adminCookie();
    const leaf = await createCategory(ctx.prisma, 'Hizmet', { offerCreditCost: 1 });
    const question = await createSelectQuestion(ctx.prisma, {
      categoryId: leaf.id,
      key: 'secim',
      sortOrder: 10,
      options: [{ key: 'a', label: 'A' }],
    });

    await request(ctx.server)
      .put(`/questions/${question.id}/router-rules`)
      .set('Cookie', cookie)
      .send({ rules: [{ optionKey: 'a', targetCategorySlug: leaf.slug }] })
      .expect(400);
  });

  it('refuses a second routing question on one category', async () => {
    const cookie = await adminCookie();
    const { router } = await routerFixture();

    const response = await request(ctx.server)
      .post(`/categories/${router.id}/questions`)
      .set('Cookie', cookie)
      .send({
        key: 'ikinci_router',
        label: 'İkinci yönlendirme',
        type: ServiceRequestQuestionType.SELECT,
        isRequired: true,
        sortOrder: 20,
        options: [{ key: 'a', label: 'A' }],
        isRouter: true,
      })
      .expect(409);

    expect(response.body.message).toContain('zaten var');
  });

  it('does not tell a visitor where a router leads', async () => {
    const { router, washer } = await routerFixture();
    // The destination is a draft the marketplace has not released.
    await ctx.prisma.serviceCategory.update({
      where: { id: washer.id },
      data: { status: ServiceCategoryStatus.DRAFT, isActive: false },
    });

    const publicView = await request(ctx.server).get(`/categories/${router.slug}`).expect(200);
    const publicQuestion = publicView.body.questions[0];

    // The options are there — the customer has to be able to choose — but the
    // categories behind them are not: naming one would announce an unreleased
    // service to anybody who opened the router.
    expect(publicQuestion.options).toHaveLength(2);
    expect(publicQuestion.routerRules).toEqual([]);
    expect(JSON.stringify(publicView.body)).not.toContain(washer.slug);

    // The admin view is where the wiring is meant to be visible.
    const cookie = await adminCookie();
    const adminView = await request(ctx.server)
      .get(`/categories/${router.slug}?includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);

    expect(adminView.body.questions[0].routerRules).toHaveLength(2);
  });

  it('keeps the management question listing to admins', async () => {
    const { router } = await routerFixture();

    // It carries the routing destinations and every inactive question, so it is
    // not a listing a visitor may read. The public form gets its questions from
    // GET /categories/:slug instead.
    await request(ctx.server).get(`/categories/${router.id}/questions`).expect(401);

    const cookie = await adminCookie();
    await request(ctx.server)
      .get(`/categories/${router.id}/questions`)
      .set('Cookie', cookie)
      .expect(200);
  });

  it('refuses a routing target that is a group', async () => {
    const cookie = await adminCookie();
    const { question } = await routerFixture();
    const group = await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });

    await request(ctx.server)
      .put(`/questions/${question.id}/router-rules`)
      .set('Cookie', cookie)
      .send({ rules: [{ optionKey: 'camasir', targetCategorySlug: group.slug }] })
      .expect(400);
  });
});

describe('provider matching uses the final leaf only', () => {
  it('shows a routed request to a provider of the leaf, never of the router', async () => {
    const { router, washer } = await routerFixture();

    const leafOwner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const leafProvider = await createDiscoverableProvider(ctx.prisma, {
      userId: leafOwner.id,
      categoryId: washer.id,
    });
    const leafCookie = await loginAs(ctx.prisma, leafOwner.id);

    const created = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(router.slug, {
          routerSelections: [{ questionKey: 'cihaz', optionKey: 'camasir' }],
        }),
      )
      .expect(201);

    await ctx.prisma.serviceRequest.update({
      where: { id: created.body.id },
      data: { status: ServiceRequestStatus.APPROVED, approvedAt: new Date() },
    });

    const discovered = await request(ctx.server)
      .get(`/providers/${leafProvider.id}/requests`)
      .set('Cookie', leafCookie)
      .expect(200);

    expect(discovered.body.map((item: { id: string }) => item.id)).toEqual([created.body.id]);
  });

  it('refuses to attach a router or a group to a provider', async () => {
    const cookie = await adminCookie();
    const { router } = await routerFixture();
    const group = await createCategory(ctx.prisma, 'Grup', { kind: ServiceCategoryKind.GROUP });

    for (const categoryId of [router.id, group.id]) {
      await request(ctx.server)
        .post('/providers')
        .set('Cookie', cookie)
        .send(providerPayload([categoryId]))
        .expect(400);
    }
  });

  it('refuses to attach a draft or closed leaf to a provider', async () => {
    const cookie = await adminCookie();
    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 1,
    });
    const closed = await createCategory(ctx.prisma, 'Kapalı', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 1,
    });

    for (const categoryId of [draft.id, closed.id]) {
      await request(ctx.server)
        .post('/providers')
        .set('Cookie', cookie)
        .send(providerPayload([categoryId]))
        .expect(400);
    }
  });
});

describe('status ⇔ isActive parity', () => {
  it('creates a draft with both columns saying draft', async () => {
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({
        name: 'Taslak hizmet',
        slug: 'taslak-hizmet',
        offerCreditCost: 2,
        status: ServiceCategoryStatus.DRAFT,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      status: ServiceCategoryStatus.DRAFT,
      isActive: false,
    });
  });

  it('keeps the two in step across draft → active → inactive', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Yaşam döngüsü', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 2,
    });

    const readBack = async () =>
      ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: category.id },
        select: { status: true, isActive: true },
      });

    expect(await readBack()).toEqual({ status: ServiceCategoryStatus.DRAFT, isActive: false });

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.ACTIVE })
      .expect(200);
    expect(await readBack()).toEqual({ status: ServiceCategoryStatus.ACTIVE, isActive: true });

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.INACTIVE })
      .expect(200);
    expect(await readBack()).toEqual({ status: ServiceCategoryStatus.INACTIVE, isActive: false });
  });

  it('keeps them in step when the whole category is saved, not just its status', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Tam kayıt', { offerCreditCost: 2 });

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', cookie)
      .send({ name: 'Tam kayıt', status: ServiceCategoryStatus.DRAFT })
      .expect(200);

    const saved = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
      select: { status: true, isActive: true },
    });
    expect(saved).toEqual({ status: ServiceCategoryStatus.DRAFT, isActive: false });
  });

  it('refuses a divergent row at the database, not just by convention', async () => {
    const category = await createCategory(ctx.prisma, 'Bütünlük', { offerCreditCost: 2 });

    // Straight past every service and DTO, the way a stray script or a psql
    // session would. An ACTIVE category that is invisible is a service nobody
    // can find; a DRAFT one that is visible is an unreleased service on the
    // public catalogue. Neither is representable.
    await expect(
      ctx.prisma.serviceCategory.update({
        where: { id: category.id },
        data: { isActive: false },
      }),
    ).rejects.toThrow();

    await expect(
      ctx.prisma.serviceCategory.update({
        where: { id: category.id },
        data: { status: ServiceCategoryStatus.DRAFT },
      }),
    ).rejects.toThrow();

    // And the row is untouched by either attempt.
    const unchanged = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
      select: { status: true, isActive: true },
    });
    expect(unchanged).toEqual({ status: ServiceCategoryStatus.ACTIVE, isActive: true });
  });

  it('maps the legacy boolean onto both columns, in both directions', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Eski istemci', { offerCreditCost: 2 });

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: false })
      .expect(200);
    expect(
      await ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: category.id },
        select: { status: true, isActive: true },
      }),
    ).toEqual({ status: ServiceCategoryStatus.INACTIVE, isActive: false });

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: true })
      .expect(200);
    expect(
      await ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: category.id },
        select: { status: true, isActive: true },
      }),
    ).toEqual({ status: ServiceCategoryStatus.ACTIVE, isActive: true });
  });

  it('never lets a legacy boolean resurrect a draft as merely "not inactive"', async () => {
    const cookie = await adminCookie();
    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 2,
    });

    // `false` cannot mean DRAFT — a boolean has no third value — so it means
    // INACTIVE, and the draft is closed rather than left in a state where the
    // two columns disagree about what it is.
    await request(ctx.server)
      .patch(`/categories/${draft.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: false })
      .expect(200);

    expect(
      await ctx.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: draft.id },
        select: { status: true, isActive: true },
      }),
    ).toEqual({ status: ServiceCategoryStatus.INACTIVE, isActive: false });
  });
});

describe('condition match modes', () => {
  /**
   * A multi-select source and a question that depends on it, with the match
   * mode left to the caller.
   */
  async function multiSourceFixture(matchMode?: QuestionConditionMatchMode) {
    const category = await createCategory(ctx.prisma, 'Banyo', { offerCreditCost: 1 });
    const source = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'yapilacak_isler',
      sortOrder: 10,
      isRequired: true,
      multi: true,
      options: [
        { key: 'tesisat', label: 'Tesisat' },
        { key: 'dolap', label: 'Dolap' },
        { key: 'kapi', label: 'Kapı' },
      ],
    });
    const dependent = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'proje_detayi',
      sortOrder: 20,
      isRequired: true,
      options: [{ key: 'var', label: 'Var' }],
    });

    await ctx.prisma.serviceRequestQuestionCondition.create({
      data: {
        questionId: dependent.id,
        sourceQuestionId: source.id,
        expectedValues: ['tesisat', 'dolap'],
        // Left unset on purpose when the caller says nothing: that is the shape
        // of a rule written before the mode existed.
        ...(matchMode ? { matchMode } : {}),
      },
    });

    return { category, source, dependent };
  }

  it('ANY shows the dependent question on one of the expected answers', async () => {
    const { category } = await multiSourceFixture(QuestionConditionMatchMode.ANY);

    // Visible, so its own required answer is demanded.
    const missing = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'yapilacak_isler', value: ['tesisat'] }],
        }),
      )
      .expect(400);
    expect(missing.body.message).toContain('proje_detayi');

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [
            { questionKey: 'yapilacak_isler', value: ['tesisat'] },
            { questionKey: 'proje_detayi', value: 'var' },
          ],
        }),
      )
      .expect(201);
  });

  it('ANY keeps it hidden when nothing expected was chosen', async () => {
    const { category } = await multiSourceFixture(QuestionConditionMatchMode.ANY);

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'yapilacak_isler', value: ['kapi'] }],
        }),
      )
      .expect(201);
  });

  it('ALL keeps it hidden until every expected answer is chosen', async () => {
    const { category } = await multiSourceFixture(QuestionConditionMatchMode.ALL);

    // One of the two is not both of them: the question does not apply, so its
    // required answer is not demanded.
    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'yapilacak_isler', value: ['tesisat'] }],
        }),
      )
      .expect(201);

    const complete = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'yapilacak_isler', value: ['tesisat', 'dolap'] }],
        }),
      )
      .expect(400);
    expect(complete.body.message).toContain('proje_detayi');
  });

  it('ALL tolerates extra answers beyond the expected set', async () => {
    const { category } = await multiSourceFixture(QuestionConditionMatchMode.ALL);

    await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [
            { questionKey: 'yapilacak_isler', value: ['tesisat', 'dolap', 'kapi'] },
            { questionKey: 'proje_detayi', value: 'var' },
          ],
        }),
      )
      .expect(201);
  });

  it('refuses an answer to a question an ALL rule keeps off screen', async () => {
    const { category } = await multiSourceFixture(QuestionConditionMatchMode.ALL);

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [
            { questionKey: 'yapilacak_isler', value: ['tesisat'] },
            { questionKey: 'proje_detayi', value: 'var' },
          ],
        }),
      )
      .expect(400);

    expect(response.body.message).toContain('görünmüyor');
  });

  it('reads a rule with no stored mode as ANY', async () => {
    const { category, dependent } = await multiSourceFixture();

    const stored = await ctx.prisma.serviceRequestQuestionCondition.findFirstOrThrow({
      where: { questionId: dependent.id },
      select: { matchMode: true },
    });
    // The column default, not something the fixture wrote.
    expect(stored.matchMode).toBe(QuestionConditionMatchMode.ANY);

    // And it behaves as ANY: one expected answer is enough to reveal it.
    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          answers: [{ questionKey: 'yapilacak_isler', value: ['dolap'] }],
        }),
      )
      .expect(400);
    expect(response.body.message).toContain('proje_detayi');
  });

  it('stores the mode an admin chooses and hands it back', async () => {
    const cookie = await adminCookie();
    const { category, dependent } = await multiSourceFixture();

    await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({
        conditions: [
          {
            sourceQuestionKey: 'yapilacak_isler',
            expectedValues: ['tesisat', 'dolap'],
            matchMode: QuestionConditionMatchMode.ALL,
          },
        ],
      })
      .expect(200);

    const listed = await request(ctx.server)
      .get(`/categories/${category.id}/questions`)
      .set('Cookie', cookie)
      .expect(200);

    const question = listed.body.find((entry: { key: string }) => entry.key === 'proje_detayi');
    expect(question.conditions[0]).toMatchObject({
      sourceQuestionKey: 'yapilacak_isler',
      matchMode: QuestionConditionMatchMode.ALL,
    });
  });

  it('defaults a rule the admin saves without a mode to ANY', async () => {
    const cookie = await adminCookie();
    const { dependent } = await multiSourceFixture();

    await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({
        conditions: [
          { sourceQuestionKey: 'yapilacak_isler', expectedValues: ['tesisat', 'dolap'] },
        ],
      })
      .expect(200);

    const stored = await ctx.prisma.serviceRequestQuestionCondition.findFirstOrThrow({
      where: { questionId: dependent.id },
      select: { matchMode: true },
    });
    expect(stored.matchMode).toBe(QuestionConditionMatchMode.ANY);
  });

  it('refuses ALL on a source the customer can only answer once', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Tek seçim', { offerCreditCost: 1 });
    await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'tadilat_tipi',
      sortOrder: 10,
      isRequired: true,
      options: [
        { key: 'komple', label: 'Komple' },
        { key: 'fayans', label: 'Fayans' },
      ],
    });
    const dependent = await createSelectQuestion(ctx.prisma, {
      categoryId: category.id,
      key: 'detay',
      sortOrder: 20,
      options: [{ key: 'var', label: 'Var' }],
    });

    // On a single-choice source the two modes are the same test, so storing the
    // distinction would put a setting on screen that changes nothing.
    const response = await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({
        conditions: [
          {
            sourceQuestionKey: 'tadilat_tipi',
            expectedValues: ['komple'],
            matchMode: QuestionConditionMatchMode.ALL,
          },
        ],
      })
      .expect(400);

    expect(response.body.message).toContain('MULTI_SELECT');
    expect(
      await ctx.prisma.serviceRequestQuestionCondition.count({
        where: { questionId: dependent.id },
      }),
    ).toBe(0);

    // ANY on the same source is accepted, so the refusal is about the mode and
    // not about the rule.
    await request(ctx.server)
      .put(`/questions/${dependent.id}/conditions`)
      .set('Cookie', cookie)
      .send({
        conditions: [{ sourceQuestionKey: 'tadilat_tipi', expectedValues: ['komple'] }],
      })
      .expect(200);
  });
});

describe('backwards compatibility', () => {
  it('still accepts the pre-taxonomy isActive switch on the status endpoint', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Eski istemci', { offerCreditCost: 1 });

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: false })
      .expect(200);

    const closed = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(closed.status).toBe(ServiceCategoryStatus.INACTIVE);
    expect(closed.isActive).toBe(false);

    await request(ctx.server)
      .patch(`/categories/${category.id}/status`)
      .set('Cookie', cookie)
      .send({ isActive: true })
      .expect(200);

    const reopened = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(reopened.status).toBe(ServiceCategoryStatus.ACTIVE);
    expect(reopened.isActive).toBe(true);
  });

  it('creates a category without naming a kind or a status, exactly as before', async () => {
    const cookie = await adminCookie();

    const response = await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({ name: 'Eski akış', slug: 'eski-akis', offerCreditCost: 3 })
      .expect(201);

    expect(response.body).toMatchObject({
      kind: ServiceCategoryKind.LEAF,
      status: ServiceCategoryStatus.ACTIVE,
      isActive: true,
    });
  });

  it('reads a request created before the taxonomy existed', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Eski', { offerCreditCost: 1 });

    // The shape of every row the migration touched: no entry category, because
    // the entry was the category.
    const legacy = await ctx.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        entryCategoryId: null,
        requestNumber: 'TR-LEGACY-1',
        customerName: 'Eski Müşteri',
        customerPhone: '05550000001',
        customerEmail: 'eski@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        status: ServiceRequestStatus.APPROVED,
      },
    });

    const response = await request(ctx.server)
      .get(`/service-requests/${legacy.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.id).toBe(legacy.id);
    expect(response.body.entryCategoryId ?? null).toBeNull();
  });
});
