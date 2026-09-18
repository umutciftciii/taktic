import { ProviderStatus, ServiceCategoryKind, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedShowcaseCard,
  createCategory,
  createDiscoverableProvider,
  createLiveShowcasePlacement,
  createShowcasePackage,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * The home page shelf: who a visitor sees, in what order, and what the response
 * is not allowed to carry.
 *
 * ## The ordering is the product
 *
 * `provider_rank` numbers each business's own cards, and the global sort reads
 * it first — so the feed is one round of everybody's best card, then a round of
 * second cards, and so on. A business with five cards gets five slots in five
 * different rounds rather than five in a row.
 *
 * That is what replaced refusing to sell a second card. The rotation case below
 * is the assertion that the replacement actually works; without it, the checkout
 * would be selling something whose value nothing protects.
 *
 * ## Nothing in the sort key can be bought
 *
 * Vitrin sells visibility, never position. There is no field a payment can move,
 * and a boost tier would need its own column ahead of `provider_rank` — a
 * visible, deliberate change rather than something this key quietly leaves room
 * for.
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

async function publisher(options: {
  categoryId: string;
  cards: number;
  areas?: Array<{ city: string; district?: string | null; neighborhood?: string | null }>;
  kind?: 'SERVICE' | 'PROMOTION';
  label: string;
}) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const profile = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId: options.categoryId,
    areas: [{ city: 'İstanbul', district: null }],
  });
  const pkg = await createShowcasePackage(ctx.prisma);
  const cardIds: string[] = [];

  for (let index = 0; index < options.cards; index += 1) {
    const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
      providerId: profile.id,
      categoryId: options.categoryId,
      kind: options.kind ?? 'SERVICE',
      title: `${options.label} ${index + 1}`,
      areas: options.areas ?? [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    await createLiveShowcasePlacement(ctx, {
      providerId: profile.id,
      cardId: card.id,
      versionId: version.id,
      packageId: pkg.id,
      // Staggered so `startAt ASC` is a total order inside a round rather than
      // a tie broken by id.
      paidAt: new Date(Date.now() - (options.cards - index) * 60_000),
    });

    cardIds.push(card.id);
  }

  return { profile, cardIds };
}

function feed(query: string) {
  return request(ctx.server).get(`/showcase/feed?${query}`);
}

describe('matching a visitor to a shelf', () => {
  it('publishes every live card when the visitor has named no place', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const kadikoy = await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'Kadıköy',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    const response = await request(ctx.server).get('/showcase/feed');

    /*
     * The reversal at the heart of this revision.
     *
     * The home page is the shelf, and a card a business paid to publish has to
     * be on it before the visitor has told anybody where they live. What keeps
     * the promise honest is the coverage printed on the card and the server
     * check on the lead — not an empty page.
     */
    expect(response.status).toBe(200);
    expect(response.body.location).toBeNull();
    const ids = response.body.cards.map((card: { cardId: string }) => card.cardId);
    expect(ids).toContain(kadikoy.cardIds[0]);
  });

  it('states the card’s whole coverage, worded, on every card', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'İl geneli',
      areas: [{ city: 'İstanbul', district: null }],
    });

    const response = await request(ctx.server).get('/showcase/feed');

    expect(response.status).toBe(200);
    // The single most load-bearing line on a card a visitor met without
    // choosing a place: what it is actually good for.
    expect(response.body.cards[0].areas).toEqual([
      {
        scope: 'CITY',
        city: 'İstanbul',
        district: null,
        neighborhood: null,
        label: 'İstanbul geneli',
      },
    ]);
  });

  it('refuses a province that names no real place, even though none is required', async () => {
    const response = await feed('city=Atlantis');

    // Absent and wrong are different: one is the home page, the other is a bad
    // query string that would otherwise read as "nobody advertises there".
    expect(response.status).toBe(400);
  });

  it('matches a province-wide card and a district card from one district query', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const wide = await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'İl geneli',
      areas: [{ city: 'İstanbul', district: null }],
    });
    const narrow = await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'Kadıköy',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    const response = await feed('city=İstanbul&district=Kadıköy');

    expect(response.status).toBe(200);
    const ids = response.body.cards.map((card: { cardId: string }) => card.cardId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(wide.cardIds[0]);
    expect(ids).toContain(narrow.cardIds[0]);
  });

  it('folds the province name the way the location table does', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 1, label: 'Kart' });

    const folded = await feed('city=ISTANBUL&district=KADIKÖY');
    const canonical = await feed('city=İstanbul&district=Kadıköy');

    // "İSTANBUL" and "istanbul" are one place, decided by `foldLocationName` —
    // the same rule that produced the stored key.
    expect(folded.status).toBe(200);
    expect(folded.body.cards).toHaveLength(1);
    expect(folded.body.cards[0].cardId).toBe(canonical.body.cards[0].cardId);
  });

  it('answers a province-only query with a prefix scan', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'Kadıköy',
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });

    const response = await feed('city=İstanbul');

    expect(response.status).toBe(200);
    expect(response.body.cards).toHaveLength(1);
  });

  it('shows one result for a card matching two of the visitor’s candidate keys', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({
      categoryId: category.id,
      cards: 1,
      label: 'İki bölge',
      areas: [
        { city: 'İstanbul', district: 'Kadıköy' },
        { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
      ],
    });

    const response = await feed('city=İstanbul&district=Kadıköy&neighborhood=Caferağa Mah');

    expect(response.status).toBe(200);
    // Two shelf rows, one card. A feed that returned the card twice would be
    // selling the same slot to itself.
    expect(response.body.cards).toHaveLength(1);
  });
});

describe('the rotation', () => {
  /**
   * The main acceptance criterion of this phase.
   *
   * Provider A holds five cards; B and C hold one each. The first three results
   * must be one card from each business — A's cards must not be adjacent — and
   * A's remaining four follow in later rounds.
   */
  it('spreads one provider’s cards across rounds instead of stacking them', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const a = await publisher({ categoryId: category.id, cards: 5, label: 'A' });
    const b = await publisher({ categoryId: category.id, cards: 1, label: 'B' });
    const c = await publisher({ categoryId: category.id, cards: 1, label: 'C' });

    const response = await feed('city=İstanbul&district=Kadıköy');
    const providers = response.body.cards.map(
      (card: { provider: { id: string } }) => card.provider.id,
    );

    expect(providers).toHaveLength(7);

    const firstRound = providers.slice(0, 3);
    expect(new Set(firstRound).size).toBe(3);
    expect(firstRound).toContain(a.profile.id);
    expect(firstRound).toContain(b.profile.id);
    expect(firstRound).toContain(c.profile.id);

    // Everything after the first round is A, because nobody else has a second
    // card — and each of those is its own round rather than a run.
    expect(providers.slice(3)).toEqual([
      a.profile.id,
      a.profile.id,
      a.profile.id,
      a.profile.id,
    ]);
  });

  it('gives the same page twice for the same query', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 3, label: 'A' });
    await publisher({ categoryId: category.id, cards: 2, label: 'B' });

    const first = await feed('city=İstanbul&district=Kadıköy');
    const second = await feed('city=İstanbul&district=Kadıköy');

    // A provider has to be able to know what they bought. A randomised order
    // would make that impossible to state.
    expect(first.body.cards.map((card: { cardId: string }) => card.cardId)).toEqual(
      second.body.cards.map((card: { cardId: string }) => card.cardId),
    );
  });

  it('pages by keyset without repeating or skipping a card', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 3, label: 'A' });
    await publisher({ categoryId: category.id, cards: 2, label: 'B' });

    const first = await feed('city=İstanbul&district=Kadıköy&limit=2');
    expect(first.body.cards).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await feed(
      `city=İstanbul&district=Kadıköy&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );

    const firstIds = first.body.cards.map((card: { cardId: string }) => card.cardId);
    const secondIds = second.body.cards.map((card: { cardId: string }) => card.cardId);
    expect(secondIds).toHaveLength(2);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('treats a malformed cursor as no cursor rather than an error', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    // A stale bookmark or a truncated URL should start somebody at the
    // beginning, not hand them an error page. A cursor grants nothing.
    const response = await feed('city=İstanbul&district=Kadıköy&cursor=not-a-cursor');

    expect(response.status).toBe(200);
    expect(response.body.cards).toHaveLength(1);
  });
});

describe('what the feed refuses to publish', () => {
  it('drops a run whose time has passed even if no sweeper has touched it', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { cardIds } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId: cardIds[0] },
      // Still ACTIVE, still `active` shelves. The reader checks the window for
      // itself, which is why a stopped sweeper cannot buy an extra day.
      data: { endAt: new Date(Date.now() - 60_000) },
    });

    const response = await feed('city=İstanbul&district=Kadıköy');
    expect(response.body.cards).toHaveLength(0);
  });

  it('drops a suspended run', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { cardIds } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId: cardIds[0] },
      data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendReason: 'ADMIN_ACTION' },
    });
    await ctx.prisma.showcasePlacementShelf.updateMany({
      where: { placement: { cardId: cardIds[0] } },
      data: { active: false },
    });

    const response = await feed('city=İstanbul&district=Kadıköy');
    expect(response.body.cards).toHaveLength(0);
  });

  it('drops every run of a provider whose application is no longer approved', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { profile } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    // Written straight to the row rather than through the endpoint: the point
    // is that the feed *joins* to this fact rather than trusting a copy of it,
    // so even a state nothing else reacted to takes the card down.
    await ctx.prisma.providerProfile.update({
      where: { id: profile.id },
      data: { status: ProviderStatus.SUSPENDED },
    });

    const response = await feed('city=İstanbul&district=Kadıköy');
    expect(response.body.cards).toHaveLength(0);
  });

  it('drops a card an operator has pulled', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { cardIds } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    await ctx.prisma.showcaseCard.update({
      where: { id: cardIds[0] },
      data: { status: 'SUSPENDED', suspendedAt: new Date() },
    });

    const response = await feed('city=İstanbul&district=Kadıköy');
    expect(response.body.cards).toHaveLength(0);
  });
});

describe('the response body', () => {
  it('carries the price on a service card and omits the key entirely on a promotion card', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 1, label: 'Hizmet', kind: 'SERVICE' });
    await publisher({ categoryId: category.id, cards: 1, label: 'Tanıtım', kind: 'PROMOTION' });

    const response = await feed('city=İstanbul&district=Kadıköy');
    const service = response.body.cards.find((card: { kind: string }) => card.kind === 'SERVICE');
    const promotion = response.body.cards.find(
      (card: { kind: string }) => card.kind === 'PROMOTION',
    );

    expect(service.listedServicePriceAmount).toBe(150_000);
    // Absent, not null. A client cannot render a price it was never given, and
    // cannot mistake a null for "free".
    expect('listedServicePriceAmount' in promotion).toBe(false);

    // Both kinds carry the response promises, because the card's call to action
    // renders its two urgency options from them.
    expect(service.responseSlaUrgentHours).toBe(3);
    expect(promotion.responseSlaNormalHours).toBe(24);
  });

  it('carries nothing about the placement, the payment or the provider’s contact details', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    const response = await feed('city=İstanbul&district=Kadıköy');
    const card = response.body.cards[0];

    // The placement id is the surface an IDOR walks — the lead endpoint resolves
    // it from the card on the server for exactly this reason.
    expect(card.placementId).toBeUndefined();
    expect(card.purchaseId).toBeUndefined();
    // What TakTick charged for the listing is nobody else's business, and when
    // a competitor's run ends is a competitor's information.
    expect(card.priceAmountSnapshot).toBeUndefined();
    expect(card.endAt).toBeUndefined();
    expect(card.areaKey).toBeUndefined();
    expect(card.providerRank).toBeUndefined();
    expect(card.provider.phone).toBeUndefined();
    expect(card.provider.email).toBeUndefined();
  });
});

describe('one card’s public page', () => {
  it('answers a live card', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { cardIds } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });

    const response = await request(ctx.server).get(`/showcase/cards/${cardIds[0]}`);

    expect(response.status).toBe(200);
    expect(response.body.cardId).toBe(cardIds[0]);
  });

  it('answers the same 404 for a card that is not published and one that does not exist', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
    });
    const { cardIds } = await publisher({ categoryId: category.id, cards: 1, label: 'A' });
    await ctx.prisma.showcasePlacement.updateMany({
      where: { cardId: cardIds[0] },
      data: { endAt: new Date(Date.now() - 60_000) },
    });

    const unpublished = await request(ctx.server).get(`/showcase/cards/${cardIds[0]}`);
    const missing = await request(ctx.server).get('/showcase/cards/does-not-exist');

    // Indistinguishable on purpose: a distinguishable answer lets anybody walk
    // the id space and read what competitors are about to advertise.
    expect(unpublished.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(unpublished.body.code).toBe(missing.body.code);
  });
});

describe('index eligibility on the feed and the card (SEO-003)', () => {
  it('answers the shelf with one boolean, and each card page with one boolean, and leaks nothing it read', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { kind: ServiceCategoryKind.LEAF });
    const thin = await publisher({ categoryId: category.id, cards: 1, label: 'İnce' });

    const shelf = await request(ctx.server).get('/showcase/feed').expect(200);
    expect(Object.keys(shelf.body).sort()).toEqual(['cards', 'location', 'nextCursor', 'seoIndexable']);
    expect(shelf.body.seoIndexable).toBe(false);
    // The shelf's answer is the shelf's; a feed card carries no such key.
    expect(shelf.body.cards[0]).not.toHaveProperty('seoIndexable');

    const card = await request(ctx.server).get(`/showcase/cards/${thin.cardIds[0]}`).expect(200);
    expect(card.body.seoIndexable).toBe(false);
    expect(Object.keys(card.body).filter((key) => /seo|index|eligib|score|reason|threshold/i.test(key))).toEqual(['seoIndexable']);
    // Nothing the rule read on the business travels with the card.
    expect(JSON.stringify(card.body)).not.toMatch(/Test işletmesi|"description"|moderasyon|0555/);
  });
});
