import { ServiceCategoryKind, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  providerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The switch that opens an unreleased service to applications: who may set it,
 * what it lets through, and the catalogue it feeds.
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
  ctx.notifications.clear();
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

describe('writing providerEnrollmentOpen', () => {
  it('opens a draft service', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(200);

    const stored = await ctx.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: category.id },
    });
    expect(stored.providerEnrollmentOpen).toBe(true);
  });

  it('creates a draft service already open, and a plain one closed', async () => {
    const cookie = await adminCookie();

    const opened = await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({
        name: 'Beyaz Eşya Tamiri',
        slug: 'beyaz-esya-tamiri-test',
        offerCreditCost: 3,
        status: ServiceCategoryStatus.DRAFT,
        providerEnrollmentOpen: true,
      })
      .expect(201);
    expect(opened.body.providerEnrollmentOpen).toBe(true);

    // Absent means closed, which is the column default and the safe one.
    const quiet = await request(ctx.server)
      .post('/categories')
      .set('Cookie', cookie)
      .send({
        name: 'Sessiz Taslak',
        slug: 'sessiz-taslak-test',
        offerCreditCost: 3,
        status: ServiceCategoryStatus.DRAFT,
      })
      .expect(201);
    expect(quiet.body.providerEnrollmentOpen).toBe(false);
  });

  /**
   * Refused rather than ignored. An operator who believes they opened a
   * category and did not is precisely the state this switch exists to prevent.
   */
  it('refuses the field on anything that is not a draft service', async () => {
    const cookie = await adminCookie();

    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    await request(ctx.server)
      .patch(`/categories/${live.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: false })
      .expect(400);

    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    await request(ctx.server)
      .patch(`/categories/${group.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(400);

    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 3,
    });
    await request(ctx.server)
      .patch(`/categories/${closed.id}`)
      .set('Cookie', cookie)
      .send({ providerEnrollmentOpen: true })
      .expect(400);
  });

  /** The rule is applied to the row being written, not the one that was there. */
  it('judges the resulting category, not the previous one', async () => {
    const cookie = await adminCookie();
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });

    // ACTIVE today, DRAFT after this same request: the field is allowed.
    await request(ctx.server)
      .patch(`/categories/${live.id}`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.DRAFT, providerEnrollmentOpen: true })
      .expect(200);

    const draft = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    // DRAFT today, ACTIVE after this request: refused.
    await request(ctx.server)
      .patch(`/categories/${draft.id}`)
      .set('Cookie', cookie)
      .send({ status: ServiceCategoryStatus.ACTIVE, providerEnrollmentOpen: true })
      .expect(400);
  });

  it('is an operator-only field', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const category = await createCategory(ctx.prisma, 'Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .patch(`/categories/${category.id}`)
      .set('Cookie', customerCookie)
      .send({ providerEnrollmentOpen: true })
      .expect(403);
  });
});

describe('the provider enrollment catalogue', () => {
  it('offers live services and the drafts an operator has opened, and nothing else', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const group = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
      providerEnrollmentOpen: true,
    });
    const closed = await createCategory(ctx.prisma, 'Kapali', {
      status: ServiceCategoryStatus.INACTIVE,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });

    // Deliberately signed out: the application form is reachable to a business
    // that has no account yet, and that is the applicant this exists for.
    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);

    const slugs = (response.body as Array<{ slug: string }>).map((row) => row.slug);
    expect(slugs).toContain(live.slug);
    expect(slugs).toContain(openDraft.slug);
    expect(slugs).not.toContain(closedDraft.slug);
    expect(slugs).not.toContain(group.slug);
    expect(slugs).not.toContain(closed.slug);
  });

  it('says which of them can take a request today', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });

    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);
    const rows = response.body as Array<{ slug: string; availability: string }>;

    expect(rows.find((row) => row.slug === live.slug)?.availability).toBe('LIVE');
    expect(rows.find((row) => row.slug === openDraft.slug)?.availability).toBe('UPCOMING');
  });

  /**
   * An allow-list asserted as an exact key set, not a handful of absences: a
   * column added to ServiceCategory later must not reach this response because
   * nobody remembered to exclude it.
   */
  it('carries nothing an applicant does not need to pick a service', async () => {
    const parent = await createCategory(ctx.prisma, 'Grup', {
      kind: ServiceCategoryKind.GROUP,
      status: ServiceCategoryStatus.DRAFT,
    });
    await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
      parentId: parent.id,
    });

    const response = await request(ctx.server).get('/categories/provider-enrollment').expect(200);
    const rows = response.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(Object.keys(row).sort()).toEqual([
      'availability',
      'iconKey',
      'id',
      'imageUrl',
      'name',
      'parent',
      'slug',
    ]);
    expect(Object.keys(row.parent as Record<string, unknown>).sort()).toEqual([
      'id',
      'name',
      'slug',
    ]);
  });
});

describe('selecting a category as a provider', () => {
  it('accepts an open draft and refuses a closed one', async () => {
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([openDraft.id]))
      .expect(201);

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([closedDraft.id]))
      .expect(400);
  });

  it('keeps a live service selectable even with the column off', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    expect(live.providerEnrollmentOpen).toBe(false);

    await request(ctx.server)
      .post('/providers')
      .send(providerPayload([live.id]))
      .expect(201);
  });

  /**
   * The profile form replaces the provider's list, so it must replace exactly
   * what the provider can manage: a draft they signed themselves up for is
   * theirs to drop, and a draft an operator bound them to behind a closed
   * enrollment is not theirs to lose.
   */
  it('a profile save drops a self-selected draft and leaves an operator-bound one alone', async () => {
    const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
    const openDraft = await createCategory(ctx.prisma, 'Acik Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
      providerEnrollmentOpen: true,
    });
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });

    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const ownerCookie = await loginAs(ctx.prisma, owner.id);
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });

    await ctx.prisma.providerServiceCategory.createMany({
      data: [
        { providerId: provider.id, categoryId: live.id },
        { providerId: provider.id, categoryId: openDraft.id },
        { providerId: provider.id, categoryId: closedDraft.id },
      ],
    });

    await request(ctx.server)
      .patch(`/providers/${provider.id}`)
      .set('Cookie', ownerCookie)
      .send(providerPayload([live.id]))
      .expect(200);

    const remaining = await ctx.prisma.providerServiceCategory.findMany({
      where: { providerId: provider.id },
      select: { categoryId: true },
    });
    expect(remaining.map((row) => row.categoryId).sort()).toEqual([live.id, closedDraft.id].sort());
  });
});
