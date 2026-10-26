import { UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';
import { matchesProviderArea } from '../src/common/provider-request-matching';

/**
 * Which requests a provider's coverage reaches — the matrix, and the discovery
 * endpoint that has to agree with it.
 *
 * The rule is one sentence: an area matches when every level it names matches
 * the request, so leaving a level out widens the reach and naming one narrows
 * it. The cases below are that sentence written out, including the two that
 * would be wrong in opposite directions — a province-wide area that fails to
 * reach a district in its own province, and a neighbourhood-scoped area that
 * reaches a sibling neighbourhood.
 *
 * B-02 adds one exception to "every level it names": a request that names no
 * neighbourhood is district-wide, and every neighbourhood-scoped area in that
 * same district takes it (4ca7ad76 had kept them apart, which left such a
 * request in front of nobody when the district's providers were all
 * neighbourhood-scoped). The widening stops at the district.
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

const CITY_AREA = { city: 'İstanbul', district: null, neighborhood: null };
const DISTRICT_AREA = { city: 'İstanbul', district: 'Kadıköy', neighborhood: null };
const NEIGHBORHOOD_AREA = {
  city: 'İstanbul',
  district: 'Kadıköy',
  neighborhood: 'Caferağa Mah',
};

describe('matchesProviderArea', () => {
  const matrix: Array<{
    name: string;
    areas: Array<{ city: string; district: string | null; neighborhood: string | null }>;
    request: { city: string; district: string; neighborhood: string | null };
    expected: boolean;
  }> = [
    // A province-wide area takes every request in that province, at any depth.
    {
      name: 'province area reaches a district request',
      areas: [CITY_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
      expected: true,
    },
    {
      name: 'province area reaches a neighbourhood request',
      areas: [CITY_AREA],
      request: { city: 'İstanbul', district: 'Beşiktaş', neighborhood: 'Bebek Mah' },
      expected: true,
    },
    {
      name: 'province area stops at the provincial border',
      areas: [CITY_AREA],
      request: { city: 'Ankara', district: 'Çankaya', neighborhood: null },
      expected: false,
    },

    // A district area takes its own district and nothing wider.
    {
      name: 'district area reaches its own district',
      areas: [DISTRICT_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
      expected: true,
    },
    {
      name: 'district area reaches a neighbourhood inside it',
      areas: [DISTRICT_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
      expected: true,
    },
    {
      name: 'district area does not reach a sibling district',
      areas: [DISTRICT_AREA],
      request: { city: 'İstanbul', district: 'Beşiktaş', neighborhood: null },
      expected: false,
    },

    // A neighbourhood area takes that neighbourhood and only that one.
    {
      name: 'neighbourhood area reaches its own neighbourhood',
      areas: [NEIGHBORHOOD_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
      expected: true,
    },
    {
      name: 'neighbourhood area does not reach a sibling neighbourhood',
      areas: [NEIGHBORHOOD_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Fenerbahçe Mah' },
      expected: false,
    },

    // B-02 — a request with no neighbourhood is district-wide. Every
    // neighbourhood-scoped area in that district takes it, and none outside it.
    {
      name: 'neighbourhood area reaches a request in its district with no neighbourhood',
      areas: [NEIGHBORHOOD_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
      expected: true,
    },
    {
      name: 'a blank neighbourhood reads as no neighbourhood',
      areas: [NEIGHBORHOOD_AREA],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: '  ' },
      expected: true,
    },
    {
      name: 'the widening does not reach a sibling district',
      areas: [NEIGHBORHOOD_AREA],
      request: { city: 'İstanbul', district: 'Beşiktaş', neighborhood: null },
      expected: false,
    },
    {
      // "Merkez" is a district of many provinces; the province still decides.
      name: 'the widening does not reach a same-named district in another province',
      areas: [{ city: 'Ankara', district: 'Merkez', neighborhood: 'Cumhuriyet Mah' }],
      request: { city: 'Kırşehir', district: 'Merkez', neighborhood: null },
      expected: false,
    },

    // Many areas: any one of them matching is enough, and none of them
    // matching is not.
    {
      name: 'a second area covers what the first does not',
      areas: [DISTRICT_AREA, { city: 'Ankara', district: null, neighborhood: null }],
      request: { city: 'Ankara', district: 'Çankaya', neighborhood: null },
      expected: true,
    },
    {
      name: 'several areas that all miss still miss',
      areas: [DISTRICT_AREA, NEIGHBORHOOD_AREA],
      request: { city: 'İzmir', district: 'Konak', neighborhood: null },
      expected: false,
    },
    {
      name: 'no areas at all reaches nothing',
      areas: [],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
      expected: false,
    },

    // Spelling is folded the Turkish way, because these are compared as text.
    {
      name: 'case and Turkish letters do not split a place in two',
      areas: [{ city: 'İSTANBUL', district: 'KADIKÖY', neighborhood: null }],
      request: { city: 'İstanbul', district: 'Kadıköy', neighborhood: null },
      expected: true,
    },
  ];

  for (const spec of matrix) {
    it(spec.name, () => {
      expect(matchesProviderArea(spec.areas, spec.request)).toBe(spec.expected);
    });
  }
});

describe('GET /providers/:providerId/requests', () => {
  async function discoverableIds(
    providerAreas: Array<{ city: string; district?: string | null; neighborhood?: string | null }>,
    requests: Array<{ city: string; district: string; neighborhood?: string | null }>,
  ) {
    const category = await createCategory(ctx.prisma);
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: providerAreas,
    });
    const created = [];
    for (const location of requests) {
      created.push(
        await createApprovedRequest(ctx.prisma, {
          categoryId: category.id,
          city: location.city,
          district: location.district,
          neighborhood: location.neighborhood ?? null,
        }),
      );
    }

    const cookie = await loginAs(ctx.prisma, user.id);
    const response = await request(ctx.server)
      .get(`/providers/${provider.id}/requests`)
      .set('Cookie', cookie)
      .expect(200);

    return {
      created,
      visible: new Set((response.body as Array<{ id: string }>).map((item) => item.id)),
    };
  }

  it('shows a province-wide provider every request in that province', async () => {
    const { created, visible } = await discoverableIds(
      [{ city: 'İstanbul' }],
      [
        { city: 'İstanbul', district: 'Kadıköy' },
        { city: 'İstanbul', district: 'Beşiktaş', neighborhood: 'Bebek Mah' },
        { city: 'Ankara', district: 'Çankaya' },
      ],
    );

    expect(visible.has(created[0]!.id)).toBe(true);
    expect(visible.has(created[1]!.id)).toBe(true);
    expect(visible.has(created[2]!.id)).toBe(false);
  });

  it('covers two unrelated provinces from two areas', async () => {
    const { created, visible } = await discoverableIds(
      [{ city: 'İstanbul', district: 'Kadıköy' }, { city: 'Ankara' }],
      [
        { city: 'İstanbul', district: 'Kadıköy' },
        { city: 'Ankara', district: 'Çankaya' },
        { city: 'İstanbul', district: 'Beşiktaş' },
      ],
    );

    expect(visible.has(created[0]!.id)).toBe(true);
    expect(visible.has(created[1]!.id)).toBe(true);
    expect(visible.has(created[2]!.id)).toBe(false);
  });

  it('shows a neighbourhood provider a district-wide request in its district, and nothing wider', async () => {
    const { created, visible } = await discoverableIds(
      [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' }],
      [
        { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
        { city: 'İstanbul', district: 'Kadıköy' },
        { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Fenerbahçe Mah' },
        { city: 'İstanbul', district: 'Beşiktaş' },
        { city: 'Ankara', district: 'Çankaya' },
      ],
    );

    expect(visible.has(created[0]!.id)).toBe(true);
    // B-02: no neighbourhood named, same district — shown.
    expect(visible.has(created[1]!.id)).toBe(true);
    // A named sibling neighbourhood is still not this one.
    expect(visible.has(created[2]!.id)).toBe(false);
    expect(visible.has(created[3]!.id)).toBe(false);
    expect(visible.has(created[4]!.id)).toBe(false);
  });

  it('still matches a provider carrying only the single area it always had', async () => {
    // The shape every profile written before multiple areas existed has, and
    // the shape the migration's backfill gives a provider that had none: one
    // district-scoped row. Nothing about its reach changed.
    const { created, visible } = await discoverableIds(
      [{ city: 'İstanbul', district: 'Kadıköy' }],
      [
        { city: 'İstanbul', district: 'Kadıköy' },
        { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' },
        { city: 'İstanbul', district: 'Beşiktaş' },
      ],
    );

    expect(visible.has(created[0]!.id)).toBe(true);
    expect(visible.has(created[1]!.id)).toBe(true);
    expect(visible.has(created[2]!.id)).toBe(false);
  });

  it('refuses the detail of a request outside every area', async () => {
    const category = await createCategory(ctx.prisma);
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' }],
    });
    const siblingDistrict = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Beşiktaş',
    });
    const siblingNeighborhood = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: 'Fenerbahçe Mah',
    });
    const cookie = await loginAs(ctx.prisma, user.id);

    for (const outside of [siblingDistrict, siblingNeighborhood]) {
      await request(ctx.server)
        .get(`/providers/${provider.id}/requests/${outside.id}`)
        .set('Cookie', cookie)
        .expect(404);
    }
  });

  it('opens the detail of a district-wide request to a neighbourhood provider in that district', async () => {
    const category = await createCategory(ctx.prisma);
    const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, {
      userId: user.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' }],
    });
    const districtWide = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      city: 'İstanbul',
      district: 'Kadıköy',
    });
    const cookie = await loginAs(ctx.prisma, user.id);

    const response = await request(ctx.server)
      .get(`/providers/${provider.id}/requests/${districtWide.id}`)
      .set('Cookie', cookie)
      .expect(200);

    // The provider is told the request names no neighbourhood — the screen's
    // "Mahalle belirtilmedi" label reads this field.
    expect(response.body).toMatchObject({ id: districtWide.id, district: 'Kadıköy', neighborhood: null });
  });
});

describe('GET /providers?city= — the operator list', () => {
  it('selects on coverage, not on the profile\'s legacy location', async () => {
    const category = await createCategory(ctx.prisma);
    // The profile's own city/district is the İstanbul/Kadıköy every fixture
    // carries; its only service area is Ankara. An operator asking who serves
    // Ankara has to be shown this one.
    const ankara = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      areas: [{ city: 'Ankara' }],
    });
    const istanbul = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }],
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    const response = await request(ctx.server)
      .get('/providers?city=Ankara')
      .set('Cookie', cookie)
      .expect(200);

    const ids = (response.body as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(ankara.id);
    expect(ids).not.toContain(istanbul.id);
  });

  it('matches any one of a provider\'s areas', async () => {
    const category = await createCategory(ctx.prisma);
    const provider = await createDiscoverableProvider(ctx.prisma, {
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: 'Kadıköy' }, { city: 'İzmir' }],
    });
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    for (const city of ['İstanbul', 'izmir']) {
      const response = await request(ctx.server)
        .get(`/providers?city=${encodeURIComponent(city)}`)
        .set('Cookie', cookie)
        .expect(200);
      expect((response.body as Array<{ id: string }>).map((item) => item.id)).toContain(
        provider.id,
      );
    }
  });
});
