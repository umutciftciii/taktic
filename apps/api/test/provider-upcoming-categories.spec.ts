import { ProviderStatus, ServiceCategoryStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * What a provider is told about the unreleased service they joined.
 *
 * The binding used to be invisible to them because they could not have made it
 * — only an operator could. Now they can make it themselves, and a category
 * that vanishes the moment it is chosen reads as a bug rather than as a release
 * process. So it comes back, in its own list, saying the one thing that is true
 * about it: not open yet.
 *
 * The list stays as narrow as it was. No supply figure, no headcount, no price:
 * that is the operator's panel, and nothing about a provider joining a draft
 * makes it theirs.
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

async function providerWithBothBindings() {
  const live = await createCategory(ctx.prisma, 'Yayinda', { offerCreditCost: 3 });
  const draft = await createCategory(ctx.prisma, 'Acik Taslak', {
    status: ServiceCategoryStatus.DRAFT,
    offerCreditCost: 3,
    providerEnrollmentOpen: true,
  });

  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, {
    userId: owner.id,
    status: ProviderStatus.APPROVED,
  });

  await ctx.prisma.providerServiceCategory.createMany({
    data: [
      { providerId: provider.id, categoryId: live.id },
      { providerId: provider.id, categoryId: draft.id },
    ],
  });

  return { live, draft, owner, provider };
}

describe('a provider’s upcoming services', () => {
  it('shows the owner their draft binding, apart from the live ones', async () => {
    const { live, draft, owner, provider } = await providerWithBothBindings();
    const cookie = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    // The list everything downstream reads — matching, offering, e-mail — is
    // unchanged, and a draft appearing in it would put this provider in front
    // of requests for a service that takes none.
    expect(
      (response.body.serviceCategories as Array<{ category: { id: string } }>).map(
        (item) => item.category.id,
      ),
    ).toEqual([live.id]);

    const upcoming = response.body.upcomingServiceCategories as Array<{
      id: string;
      category: Record<string, unknown>;
    }>;
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.category.id).toBe(draft.id);
    expect(Object.keys(upcoming[0]!.category).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('shows a stranger nothing at all', async () => {
    const { provider } = await providerWithBothBindings();

    const anonymous = await request(ctx.server).get(`/providers/${provider.id}`).expect(200);
    expect(anonymous.body.visibility).toBe('public');
    expect(anonymous.body).not.toHaveProperty('upcomingServiceCategories');

    const other = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const otherCookie = await loginAs(ctx.prisma, other.id);
    const asOther = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', otherCookie)
      .expect(200);
    expect(asOther.body).not.toHaveProperty('upcomingServiceCategories');
  });

  /**
   * The line between the two kinds of draft binding, and the reason the list is
   * bounded by enrollment rather than by DRAFT alone.
   */
  it('stays silent about a draft the operator has not opened to applications', async () => {
    const closedDraft = await createCategory(ctx.prisma, 'Kapali Taslak', {
      status: ServiceCategoryStatus.DRAFT,
      offerCreditCost: 3,
    });
    const { owner, provider } = await providerWithBothBindings();
    await ctx.prisma.providerServiceCategory.create({
      data: { providerId: provider.id, categoryId: closedDraft.id },
    });

    const cookie = await loginAs(ctx.prisma, owner.id);
    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    // That binding is the operator preparing an unreleased service. Its name is
    // the unreleased catalogue, and this provider could not have chosen it.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(closedDraft.slug);
    expect(serialized).not.toContain(closedDraft.name);
  });

  it('carries no supply figure to the provider', async () => {
    const { owner, provider } = await providerWithBothBindings();
    const cookie = await loginAs(ctx.prisma, owner.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}`)
      .set('Cookie', cookie)
      .expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('supplyStatus');
    expect(body).not.toContain('approvedProviderCount');
    expect(body).not.toContain('offerCreditCost');
  });
});
