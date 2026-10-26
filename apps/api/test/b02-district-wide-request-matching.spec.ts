import { CategoryDeliveryModel, RequestDeliveryMode, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { matchesRequestLocation } from '../src/common/provider-request-matching';
import { areaCovers } from '../src/common/provider-service-area-scope';
import { RequestPublishOutbox } from '../src/modules/notifications/request-publish-outbox.service';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  currentCreditBalance,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * B-02 — a request that names no neighbourhood is district-wide, and every
 * neighbourhood-scoped provider in that province and district may see it, act
 * on it and be told about it. Nothing wider: a sibling district, a same-named
 * district in another province and a request that names a different
 * neighbourhood stay out, REMOTE requests are unchanged, and `areaCovers` (the
 * profile and showcase containment test) is not widened with it.
 *
 * Every provider-facing surface reads one predicate, so each is asked here:
 * the discovery list and detail, the offer and its credit debit, and the
 * publish fan-out with the mail it sends.
 */

let ctx: TestContext;
let outbox: RequestPublishOutbox;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(RequestPublishOutbox);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

type Area = { city: string; district?: string | null; neighborhood?: string | null };

const CAFERAGA: Area = { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' };
const BEBEK: Area = { city: 'İstanbul', district: 'Beşiktaş', neighborhood: 'Bebek Mah' };
const KADIKOY: Area = { city: 'İstanbul', district: 'Kadıköy' };

type Party = { id: string; email: string; cookie: string };

async function addProvider(categoryId: string, areas: Area[], credits = 10): Promise<Party> {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: user.id, categoryId, areas });
  if (credits > 0) {
    await grantCredits(ctx.prisma, provider.id, credits);
  }
  return { id: provider.id, email: user.email!, cookie: await loginAs(ctx.prisma, user.id) };
}

function postOffer(party: Party, requestId: string) {
  return request(ctx.server)
    .post(`/providers/${party.id}/requests/${requestId}/offers`)
    .set('Cookie', party.cookie)
    .send(offerPayload());
}

async function publish(requestId: string, approvedAt: Date) {
  return ctx.prisma.$transaction((tx) => outbox.enqueue(tx, requestId, approvedAt));
}

async function invitedProviderIds(requestId: string) {
  const rows = await ctx.prisma.notificationLog.findMany({
    where: { template: 'request-available', requestId },
    select: { providerId: true },
  });
  return rows.map((row) => row.providerId).sort();
}

describe('B-02 — the rule, where it is defined', () => {
  it('leaves REMOTE requests unfiltered by place, whatever the neighbourhood', () => {
    const areas = [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' }];
    const place = { city: 'Ankara', district: 'Çankaya', neighborhood: null };
    expect(matchesRequestLocation(areas, { ...place, deliveryMode: RequestDeliveryMode.REMOTE })).toBe(true);
    expect(matchesRequestLocation(areas, { ...place, deliveryMode: RequestDeliveryMode.ON_SITE })).toBe(false);
  });

  it('does not widen areaCovers: a neighbourhood area still does not cover its district', () => {
    const neighbourhood = { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' };
    const district = { city: 'İstanbul', district: 'Kadıköy', neighborhood: null };
    expect(areaCovers(neighbourhood, district)).toBe(false);
    expect(areaCovers(district, neighbourhood)).toBe(true);
  });
});

describe('B-02 — offer authority and the credit debit', () => {
  it('lets a neighbourhood provider offer on a district-wide request in its district, debiting once', async () => {
    const category = await createCategory(ctx.prisma, 'Boya', { offerCreditCost: 2 });
    const party = await addProvider(category.id, [CAFERAGA], 10);
    const districtWide = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
    });

    await postOffer(party, districtWide.id).expect(201);
    // The same provider cannot bid twice in the round, so the debit is single.
    await postOffer(party, districtWide.id).expect((response) => {
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    expect(await currentCreditBalance(ctx.prisma, party.id)).toBe(8);
    expect(await ctx.prisma.offer.count({ where: { requestId: districtWide.id, providerId: party.id } })).toBe(1);
  });

  it('refuses the offer, and spends nothing, outside the district or for another named neighbourhood', async () => {
    const category = await createCategory(ctx.prisma, 'Boya', { offerCreditCost: 2 });
    const party = await addProvider(category.id, [CAFERAGA], 10);
    const siblingDistrict = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Beşiktaş',
    });
    const siblingNeighbourhood = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: 'Fenerbahçe Mah',
    });
    const otherProvince = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'Ankara',
      district: 'Çankaya',
    });

    for (const outside of [siblingDistrict, siblingNeighbourhood, otherProvince]) {
      await postOffer(party, outside.id).expect(404);
    }

    expect(await currentCreditBalance(ctx.prisma, party.id)).toBe(10);
    expect(await ctx.prisma.offer.count({ where: { providerId: party.id } })).toBe(0);
  });
});

describe('B-02 — the publish fan-out', () => {
  it('invites the district’s neighbourhood providers to a district-wide request, and nobody beyond the district', async () => {
    const category = await createCategory(ctx.prisma);
    const caferaga = await addProvider(category.id, [CAFERAGA]);
    const districtProvider = await addProvider(category.id, [KADIKOY]);
    const bebek = await addProvider(category.id, [BEBEK]);
    const ankara = await addProvider(category.id, [{ city: 'Ankara', district: 'Çankaya', neighborhood: 'Kızılay Mah' }]);
    const approvedAt = new Date();
    const districtWide = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      approvedAt,
    });

    const result = await publish(districtWide.id, approvedAt);

    expect(result).toEqual({ reached: 2, enqueued: 3 });
    expect(await invitedProviderIds(districtWide.id)).toEqual([caferaga.id, districtProvider.id].sort());
    expect(await invitedProviderIds(districtWide.id)).not.toContain(bebek.id);
    expect(await invitedProviderIds(districtWide.id)).not.toContain(ankara.id);

    // Delivery re-derives the audience through the same predicate and sends.
    const delivered = await outbox.deliverPending();
    expect(delivered).toEqual({ claimed: 3, sent: 3, failed: 0, unavailable: 0 });
    const toCaferaga = ctx.notifications.sent.find(
      (message) => message.template === 'request-available' && message.to === caferaga.email,
    );
    expect(toCaferaga?.data).toMatchObject({ district: 'Kadıköy', neighborhoodUnspecified: 'true' });
    // The customer's figure counts the widened audience.
    const published = ctx.notifications.sent.find((message) => message.template === 'request-published');
    expect(published?.data).toMatchObject({ reachedProviderCount: '2' });
  });

  it('keeps a request that names a neighbourhood exact: no sibling neighbourhood, no notice', async () => {
    const category = await createCategory(ctx.prisma);
    const caferaga = await addProvider(category.id, [CAFERAGA]);
    const fenerbahce = await addProvider(category.id, [
      { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Fenerbahçe Mah' },
    ]);
    const approvedAt = new Date();
    const named = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: 'Caferağa Mah',
      approvedAt,
    });

    expect(await publish(named.id, approvedAt)).toEqual({ reached: 1, enqueued: 2 });
    expect(await invitedProviderIds(named.id)).toEqual([caferaga.id]);
    expect(await invitedProviderIds(named.id)).not.toContain(fenerbahce.id);

    await outbox.deliverPending();
    const invitation = ctx.notifications.sent.find((message) => message.template === 'request-available');
    expect(invitation?.data).toMatchObject({ neighborhoodUnspecified: null });
  });

  it('sends nothing retroactively: a request published before the provider matched gets no new invitation', async () => {
    const category = await createCategory(ctx.prisma);
    const approvedAt = new Date();
    const districtWide = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      approvedAt,
    });
    // Published while nobody matched — the customer notice only, as the old
    // rule left a district-wide request whose district had only neighbourhood
    // providers.
    expect(await publish(districtWide.id, approvedAt)).toEqual({ reached: 0, enqueued: 1 });
    await outbox.deliverPending();
    ctx.notifications.clear();

    const caferaga = await addProvider(category.id, [CAFERAGA]);
    // The sweeps that run on every tick only deliver what publish enqueued.
    await outbox.deliverPending();

    expect(ctx.notifications.sent).toHaveLength(0);
    expect(await invitedProviderIds(districtWide.id)).toEqual([]);
    // The request is still in front of the provider on their own screen.
    const list = await request(ctx.server)
      .get(`/providers/${caferaga.id}/requests`)
      .set('Cookie', caferaga.cookie)
      .expect(200);
    expect(list.body.map((item: { id: string }) => item.id)).toContain(districtWide.id);
  });

  it('carries the widened audience through the sweep limit: once per provider, none lost, none twice', async () => {
    // What bounds a fan-out is the per-(request, provider, round) dedupe key and
    // the per-sweep delivery limit; there is no per-recipient daily cap on
    // `request-available`. A wider audience is a longer queue, never a dropped
    // or a doubled invitation.
    const category = await createCategory(ctx.prisma);
    const parties = [
      await addProvider(category.id, [CAFERAGA]),
      await addProvider(category.id, [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Moda Mah' }]),
      await addProvider(category.id, [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Fenerbahçe Mah' }]),
    ];
    const approvedAt = new Date();
    const districtWide = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      approvedAt,
    });

    expect(await publish(districtWide.id, approvedAt)).toEqual({ reached: 3, enqueued: 4 });
    // A second publish of the same round adds nothing.
    expect((await publish(districtWide.id, approvedAt)).enqueued).toBe(0);

    const first = await outbox.deliverPending({ limit: 2 });
    const second = await outbox.deliverPending({ limit: 2 });
    const third = await outbox.deliverPending({ limit: 2 });

    expect([first.claimed, second.claimed, third.claimed]).toEqual([2, 2, 0]);
    const invited = ctx.notifications.sent
      .filter((message) => message.template === 'request-available')
      .map((message) => message.to)
      .sort();
    expect(invited).toEqual(parties.map((party) => party.email).sort());
  });

  it('leaves a REMOTE request’s audience unchanged by place', async () => {
    const category = await createCategory(ctx.prisma, 'Danışmanlık', {
      deliveryModel: CategoryDeliveryModel.REMOTE,
    });
    const caferaga = await addProvider(category.id, [CAFERAGA]);
    const ankara = await addProvider(category.id, [{ city: 'Ankara', district: 'Çankaya' }]);
    const approvedAt = new Date();
    const remote = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İzmir',
      district: 'Konak',
      approvedAt,
      deliveryMode: RequestDeliveryMode.REMOTE,
    });

    await publish(remote.id, approvedAt);
    expect(await invitedProviderIds(remote.id)).toEqual([caferaga.id, ankara.id].sort());

    await outbox.deliverPending();
    const invitations = ctx.notifications.sent.filter((message) => message.template === 'request-available');
    // The district-wide notice is an ON_SITE statement; the template ignores it
    // for REMOTE, and the data says what the request said.
    expect(invitations).toHaveLength(2);
  });
});
