import { AdminPermission, OfferStatus, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { matchesAdminSearch, parseAdminSearch } from '../src/common/admin-search';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * ADMIN-SEARCH-NORMALIZATION-001: the operator's search box finds a phone
 * number in whatever spelling it was typed, against whatever spelling it was
 * stored in.
 *
 * `User.phone` and `ProviderProfile.phone` are E.164; `ServiceRequest
 * .customerPhone` is a snapshot whose older rows are digits-only. Before this,
 * every admin search was a substring match. `05551234567` happens to sit
 * inside `+905551234567`, so the bare national form already worked against an
 * E.164 column; what missed was every grouped spelling (`0555 123 45 67`,
 * `(555) 123-45-67`) against any column, and the canonical or `90…` form
 * against an older digits-only request (`+90555…` is not inside `0555…`).
 */

const CANONICAL = '+905551234567';
const OTHER = '+905559876543';
/** Every spelling an operator plausibly types for {@link CANONICAL}. */
const SPELLINGS = ['05551234567', '5551234567', '905551234567', '+905551234567', '0 (555) 123 45 67'];

describe('parseAdminSearch / matchesAdminSearch (pure)', () => {
  it('reads every spelling of one number as that number’s stored spellings', () => {
    for (const spelling of SPELLINGS) {
      const term = parseAdminSearch(spelling);
      expect(term?.phoneSpellings).toEqual(
        expect.arrayContaining(['+905551234567', '05551234567', '5551234567', '905551234567']),
      );
      expect(term?.phoneSpellings?.length).toBeLessThanOrEqual(4);
    }
  });

  it('is no search at all for a blank or absent box', () => {
    expect(parseAdminSearch(undefined)).toBeNull();
    expect(parseAdminSearch(null)).toBeNull();
    expect(parseAdminSearch('   ')).toBeNull();
    expect(parseAdminSearch(['a', 'b'] as unknown as string)).toBeNull();
  });

  it('trims the text and leaves anything that is not a whole number as plain text', () => {
    for (const raw of ['5551234', '+', '++90', '0555-12', '123456789012345678', 'Usta 5551234567', 'cmabc0555123456700', 'TR-2026-000123']) {
      const term = parseAdminSearch(`  ${raw}  `);
      expect(term).toEqual({ text: raw, phoneSpellings: null });
    }
  });

  it('folds text the Turkish way as before, and locale-free as well', () => {
    const term = (raw: string) => parseAdminSearch(raw)!;
    expect(matchesAdminSearch(term('ışık'), { text: ['Işık Tesisat'], phone: [] })).toBe(true);
    expect(matchesAdminSearch(term('İSTANBUL'), { text: ['İstanbul'], phone: [] })).toBe(true);
    expect(matchesAdminSearch(term('Ivan@Example.test'), { text: ['ivan@example.test'], phone: [] })).toBe(true);
    expect(matchesAdminSearch(term('ivan@example.test'), { text: ['ivana@example.test'], phone: [] })).toBe(false);
  });

  it('matches a phone column exactly on the number’s spellings, never a different number', () => {
    const term = parseAdminSearch('0555 123 45 67')!;
    expect(matchesAdminSearch(term, { text: [], phone: ['+905551234567'] })).toBe(true);
    expect(matchesAdminSearch(term, { text: [], phone: ['5551234567'] })).toBe(true);
    expect(matchesAdminSearch(term, { text: [], phone: [OTHER] })).toBe(false);
    expect(matchesAdminSearch(term, { text: [], phone: [null] })).toBe(false);
  });
});

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
});

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: null });
  return loginAs(ctx.prisma, user.id);
}

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

async function get(path: string, cookie: string) {
  const response = await request(ctx.server).get(path).set('Cookie', cookie);
  expect(response.status).toBe(200);
  return response.body;
}

const q = (value: string) => `q=${encodeURIComponent(value)}`;
type Row = { id: string };
const ids = (rows: Row[]) => rows.map((row) => row.id);

describe('GET /users and /customers — canonical User.phone', () => {
  it('finds a staff account by every spelling, and not by a different number', async () => {
    const staff = await createUser(ctx.prisma, { role: UserRole.ADMIN, phone: CANONICAL });
    const other = await createUser(ctx.prisma, { role: UserRole.ADMIN, phone: OTHER });
    const cookie = await superAdmin();

    for (const spelling of SPELLINGS) {
      const found = ids((await get(`/users?${q(spelling)}`, cookie)).items);
      expect(found, spelling).toContain(staff.id);
      expect(found, spelling).not.toContain(other.id);
    }
  });

  it('finds a customer by a local-format number, and keeps the substring search', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: CANONICAL, name: 'Ayşe Yılmaz' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: OTHER });
    const cookie = await superAdmin();

    // `05551234567` is already a substring of `+905551234567`; the spellings a
    // substring match missed are the grouped ones people copy from a card.
    for (const spelling of ['0555 123 45 67', '(555) 123-45-67', '+90 555 123 45 67', '05551234567']) {
      expect(ids((await get(`/customers?${q(spelling)}`, cookie)).items), spelling).toEqual([customer.id]);
    }
    // A fragment of the stored number still finds it as it always did.
    expect(ids((await get(`/customers?${q('1234567')}`, cookie)).items)).toEqual([customer.id]);
    expect(ids((await get(`/customers?${q('Yılmaz')}`, cookie)).items)).toEqual([customer.id]);
  });

  it('finds an e-mail whatever its case or surrounding space', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'ivan.kaya@example.test' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, email: 'ivana@example.test' });
    const cookie = await superAdmin();

    expect(ids((await get(`/customers?${q('  Ivan.Kaya@EXAMPLE.test ')}`, cookie)).items)).toEqual([customer.id]);
  });
});

describe('GET /providers — canonical ProviderProfile.phone', () => {
  it('finds the provider by a local-format number, not a different one', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { phone: CANONICAL } });
    const other = await createProviderProfile(ctx.prisma);
    await ctx.prisma.providerProfile.update({ where: { id: other.id }, data: { phone: OTHER } });
    const cookie = await superAdmin();

    for (const spelling of SPELLINGS) {
      expect(ids(await get(`/providers?${q(spelling)}`, cookie)), spelling).toEqual([provider.id]);
    }
    expect(ids(await get('/providers', cookie)).sort()).toEqual([provider.id, other.id].sort());
  });

  it('keeps the Turkish text search and survives phone-like nonsense', async () => {
    const provider = await createProviderProfile(ctx.prisma);
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { businessName: 'Işık Tesisat' } });
    await createProviderProfile(ctx.prisma);
    const cookie = await superAdmin();

    expect(ids(await get(`/providers?${q('ışık')}`, cookie))).toEqual([provider.id]);
    expect(await get(`/providers?${q('+')}`, cookie)).toEqual([]);
    expect(await get(`/providers?${q('0555-12-')}`, cookie)).toEqual([]);
    expect(await get(`/providers?${q('99999999999999999999')}`, cookie)).toEqual([]);
  });
});

describe('GET /service-requests — historical and canonical customerPhone', () => {
  it('finds a historical local-format snapshot by the canonical number, and a canonical one by the local number', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const historical = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: '05551234567' });
    const trunkless = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: '5551234567' });
    const canonical = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: CANONICAL });
    const other = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: OTHER });
    const cookie = await superAdmin();

    for (const spelling of SPELLINGS) {
      const found = ids(await get(`/service-requests?${q(spelling)}`, cookie));
      expect(found.sort(), spelling).toEqual([historical.id, trunkless.id, canonical.id].sort());
      expect(found, spelling).not.toContain(other.id);
    }
  });

  it('keeps the text search over name, e-mail, category and place', async () => {
    const category = await createCategory(ctx.prisma, 'Boya Badana');
    const row = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerEmail: 'ivan@example.test',
      district: 'Üsküdar',
    });
    await createApprovedRequest(ctx.prisma, { categoryId: (await createCategory(ctx.prisma, 'Klima')).id });
    const cookie = await superAdmin();

    for (const text of ['boya', 'Ivan@example.test', 'üsküdar', row.customerName]) {
      expect(ids(await get(`/service-requests?${q(text)}`, cookie)), text).toEqual([row.id]);
    }
    expect(await get(`/service-requests?${q('5551234')}`, cookie)).toEqual([]);
  });
});

async function offerWorld() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { phone: CANONICAL } });
  await grantCredits(ctx.prisma, provider.id, 10);
  const historical = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: '05557654321' });
  const unrelated = await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerPhone: OTHER });
  const offerOn = (requestId: string) =>
    ctx.prisma.offer.create({
      data: { requestId, providerId: provider.id, status: OfferStatus.SUBMITTED, priceAmount: 1000, message: 'x', creditCost: 0 },
    });
  return { provider, historicalOffer: await offerOn(historical.id), unrelatedOffer: await offerOn(unrelated.id) };
}

describe('GET /offers — provider phone and request snapshot', () => {
  it('finds offers by the provider’s number typed locally, and by a historical snapshot typed canonically', async () => {
    const { historicalOffer, unrelatedOffer } = await offerWorld();
    const cookie = await superAdmin();

    expect(ids((await get(`/offers?${q('05551234567')}`, cookie)).items).sort()).toEqual(
      [historicalOffer.id, unrelatedOffer.id].sort(),
    );
    expect(ids((await get(`/offers?${q('+905557654321')}`, cookie)).items)).toEqual([historicalOffer.id]);
    expect((await get(`/offers?${q('+905550000000')}`, cookie)).items).toEqual([]);
  });

  it('never matches a phone the caller may not read, in any spelling', async () => {
    await offerWorld();
    const cookie = await sessionWith([AdminPermission.OFFERS_READ]);

    expect((await get(`/offers?${q('05551234567')}`, cookie)).items).toEqual([]);
    expect((await get(`/offers?${q('+905557654321')}`, cookie)).items).toEqual([]);
  });
});

describe('GET /finance/providers and /finance/credit-ledger — provider phone', () => {
  it('finds the provider by a local-format number with PROVIDERS_READ', async () => {
    const { provider } = await offerWorld();
    const cookie = await sessionWith([
      AdminPermission.FINANCE_READ,
      AdminPermission.FINANCE_LEDGER_READ,
      AdminPermission.PROVIDERS_READ,
    ]);

    const finance = (await get(`/finance/providers?${q('0555 123 45 67')}`, cookie)).items;
    const ledger = (await get(`/finance/credit-ledger?${q('5551234567')}`, cookie)).items;
    expect(finance.map((row: { provider: { id: string } }) => row.provider.id)).toEqual([provider.id]);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row: { provider: { id: string } }) => row.provider.id === provider.id)).toBe(true);
  });

  it('matches no spelling of the phone without PROVIDERS_READ', async () => {
    await offerWorld();
    const cookie = await sessionWith([AdminPermission.FINANCE_READ, AdminPermission.FINANCE_LEDGER_READ]);

    expect((await get(`/finance/providers?${q('05551234567')}`, cookie)).items).toHaveLength(0);
    expect((await get(`/finance/credit-ledger?${q('05551234567')}`, cookie)).items).toHaveLength(0);
  });
});
