import { AdminPermission, OfferStatus, Prisma, ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * ADMIN-SEARCH-TURKISH-HARDENING-001: the admin lists that search in the
 * database (users, customers, offers, finance) fold Turkish text the Turkish
 * way.
 *
 * The database's collation is en_US.utf8 on musl: its `ILIKE` folds `I` to
 * `i`, never to `ı`, so "ışık" never found "Işık Müşteri". Each searched text
 * column now has a STORED generated twin folded by `taktic_search_fold` (NFC,
 * collapsed whitespace, ICU Turkish lower-case), and the box is folded by the
 * same function. The old `ILIKE` stays beside it, so nothing the search found
 * before is lost — "ivan" still finds "Ivan Petrov".
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
  resetAuthThrottle(ctx.app);
});

async function fold(value: string | null): Promise<string | null> {
  const rows = await ctx.prisma.$queryRaw<Array<{ folded: string | null }>>(
    Prisma.sql`SELECT taktic_search_fold(${value}::text) AS "folded"`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.folded ?? null;
}

describe('taktic_search_fold (the one fold, in the database)', () => {
  // Upper ↔ lower pairs of the Turkish alphabet's special letters. The I pair
  // is the whole reason this exists: dotless I ↔ ı, dotted İ ↔ i.
  const PAIRS: Array<[string, string]> = [
    ['I', 'ı'],
    ['İ', 'i'],
    ['Ş', 'ş'],
    ['Ğ', 'ğ'],
    ['Ü', 'ü'],
    ['Ö', 'ö'],
    ['Ç', 'ç'],
  ];

  it.each(PAIRS)('folds %s to %s, and %s to itself', async (upper, lower) => {
    expect(await fold(upper)).toBe(lower);
    expect(await fold(lower)).toBe(lower);
    expect(await fold(`${upper}x${upper}`)).toBe(`${lower}x${lower}`);
  });

  it('folds every casing of one Turkish name to one value', async () => {
    const folded = await Promise.all(['Işık Müşteri', 'IŞIK MÜŞTERİ', 'ışık müşteri', 'ışık MÜŞTERİ'].map(fold));
    expect(new Set(folded)).toEqual(new Set(['ışık müşteri']));
    expect(await fold('İşık Müşteri')).toBe('işık müşteri');
  });

  it('does not transliterate: ç, ğ, ı, ö, ş, ü stay letters of their own', async () => {
    expect(await fold('Çağrı Şahin')).toBe('çağrı şahin');
    expect(await fold('Özgür Ünal')).toBe('özgür ünal');
    expect(await fold('Çağrı')).not.toBe(await fold('cagri'));
  });

  it('composes, collapses and trims, and keeps NULL as NULL', async () => {
    // "Işık" with a decomposed ş (s + U+0327) is the same name.
    expect(await fold('Işık')).toBe('ışık');
    // İ written as I + combining dot above is İ.
    expect(await fold('İşık')).toBe('işık');
    expect(await fold('  Işık \t  Müşteri  ')).toBe('ışık müşteri');
    expect(await fold(null)).toBeNull();
  });
});

describe('the generated columns', () => {
  it('are computed by PostgreSQL on insert and update, and refuse a direct write', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'IŞIK Müşteri' });
    const read = async () =>
      (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { nameSearch: true } })
      ).nameSearch;

    expect(await read()).toBe('ışık müşteri');
    await ctx.prisma.user.update({ where: { id: user.id }, data: { name: 'İnci  Çiçek' } });
    expect(await read()).toBe('inci çiçek');
    await ctx.prisma.user.update({ where: { id: user.id }, data: { name: null } });
    expect(await read()).toBeNull();

    await expect(
      ctx.prisma.user.update({ where: { id: user.id }, data: { nameSearch: 'forged' } }),
    ).rejects.toThrow();
  });

  it('are left out of every read that does not ask for them', async () => {
    const user = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Işık' });
    const provider = await createProviderProfile(ctx.prisma);
    const category = await createCategory(ctx.prisma, 'Klima');
    const serviceRequest = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
    const grant = await grantCredits(ctx.prisma, provider.id, 1);

    const keys = [
      Object.keys(await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })),
      Object.keys(await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: provider.id } })),
      Object.keys(await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: serviceRequest.id } })),
      Object.keys(await ctx.prisma.providerCreditTransaction.findUniqueOrThrow({ where: { id: grant.id } })),
      Object.keys(user),
      Object.keys(provider),
      Object.keys(serviceRequest),
      Object.keys(grant),
    ].flat();
    expect(keys.filter((key) => key.endsWith('Search'))).toEqual([]);
  });
});

async function superAdmin() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: null, name: 'Root' });
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
const ids = (rows: Row[]) => rows.map((row) => row.id).sort();

/** The acceptance matrix: six stored names × nine boxes. */
const NAMES = {
  isikTitle: 'Işık Müşteri',
  isikUpper: 'IŞIK MÜŞTERİ',
  isikLower: 'ışık müşteri',
  isikDotted: 'İşık Müşteri',
  cagri: 'Çağrı Şahin',
  ozgur: 'Özgür Ünal',
} as const;
type NameKey = keyof typeof NAMES;

/**
 * What each box finds. Turkish case folding finds every casing of the same
 * word; no box transliterates ("cagri" is not "Çağrı"). Two rows come from the
 * locale-free arm kept from before — musl folds both `I` and `İ` to `i`, so
 * "Işık" also reaches "İşık" and "İŞİK" reaches "IŞIK"; the search found
 * those before this change and still does.
 */
const MATRIX: Array<[string, NameKey[]]> = [
  ['ışık', ['isikTitle', 'isikUpper', 'isikLower']],
  ['Işık', ['isikTitle', 'isikUpper', 'isikLower', 'isikDotted']],
  ['ISIK', []],
  ['isik', []],
  ['İŞİK', ['isikUpper']],
  ['çağrı', ['cagri']],
  ['cagri', []],
  ['özgür', ['ozgur']],
  ['ozgur', []],
  ['ışık müşteri', ['isikTitle', 'isikUpper', 'isikLower']],
  ['  IŞIK   müşteri ', ['isikTitle', 'isikUpper', 'isikLower']],
  ['işık', ['isikTitle', 'isikDotted']],
];

describe('GET /customers — Turkish names', () => {
  it.each(MATRIX)('box %j finds exactly %j', async (box, expected) => {
    const byKey = {} as Record<NameKey, string>;
    for (const key of Object.keys(NAMES) as NameKey[]) {
      byKey[key] = (await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: NAMES[key] })).id;
    }
    const cookie = await superAdmin();

    expect(ids((await get(`/customers?${q(box)}`, cookie)).items)).toEqual(expected.map((key) => byKey[key]).sort());
  });

  it('keeps the locale-free arm: "ivan" finds "Ivan Petrov", and an e-mail in any case', async () => {
    const ivan = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Ivan Petrov', email: 'x1@example.test' });
    const mail = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Ayşe', email: 'ivan.kaya@example.test' });
    const cookie = await superAdmin();

    expect(ids((await get(`/customers?${q('ivan p')}`, cookie)).items)).toEqual([ivan.id]);
    expect(ids((await get(`/customers?${q('IVAN.KAYA@EXAMPLE.TEST')}`, cookie)).items)).toEqual([mail.id]);
    expect(ids((await get(`/customers?${q('Ivan')}`, cookie)).items)).toEqual([ivan.id, mail.id].sort());
  });

  it('keeps every phone spelling, and a partial number falls back to text', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905551234567', name: 'Işıl' });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905559876543', name: 'Başka' });
    const cookie = await superAdmin();

    for (const box of ['0555 123 45 67', '(555) 123-45-67', '+90 555 123 45 67', '5551234', 'ışıl']) {
      expect(ids((await get(`/customers?${q(box)}`, cookie)).items), box).toEqual([customer.id]);
    }
  });
});

describe('GET /users — Turkish staff names', () => {
  it('finds "Işık Müşteri" by "ışık müşteri", keeps e-mail and phone', async () => {
    const staff = await createUser(ctx.prisma, {
      role: UserRole.ADMIN,
      name: 'Işık Müşteri',
      email: 'ivan.staff@example.test',
      phone: '+905551112233',
    });
    await createUser(ctx.prisma, { role: UserRole.ADMIN, name: 'Başka Biri' });
    const cookie = await superAdmin();

    for (const box of ['ışık müşteri', 'IŞIK', 'Ivan.Staff@Example.test', '0555 111 22 33']) {
      expect(ids((await get(`/users?${q(box)}`, cookie)).items), box).toEqual([staff.id]);
    }
  });
});

async function offerWorld() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  await ctx.prisma.providerProfile.update({
    where: { id: provider.id },
    data: { businessName: 'IŞIK Tesisat', contactName: 'İlker Işıkçı', email: 'ivan.usta@example.test' },
  });
  await grantCredits(ctx.prisma, provider.id, 10);
  const other = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  const located = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    city: 'Iğdır',
    district: 'Aralık',
    customerEmail: 'ivan.musteri@example.test',
  });
  await ctx.prisma.serviceRequest.update({ where: { id: located.id }, data: { customerName: 'Irmak Işın' } });
  const elsewhere = await createApprovedRequest(ctx.prisma, { categoryId: category.id });
  const offerOn = (requestId: string, providerId: string) =>
    ctx.prisma.offer.create({
      data: { requestId, providerId, status: OfferStatus.SUBMITTED, priceAmount: 1000, message: 'x', creditCost: 0 },
    });
  return {
    provider,
    providerOffer: await offerOn(elsewhere.id, provider.id),
    requestOffer: await offerOn(located.id, other.id),
  };
}

describe('GET /offers — provider and request text', () => {
  it('folds business name, contact name, customer name, city and district', async () => {
    const { providerOffer, requestOffer } = await offerWorld();
    const cookie = await superAdmin();

    expect(ids(await get(`/offers?${q('ışık tesisat')}`, cookie))).toEqual([providerOffer.id]);
    expect(ids(await get(`/offers?${q('ilker ışıkçı')}`, cookie))).toEqual([providerOffer.id]);
    expect(ids(await get(`/offers?${q('ırmak ışın')}`, cookie))).toEqual([requestOffer.id]);
    expect(ids(await get(`/offers?${q('ığdır')}`, cookie))).toEqual([requestOffer.id]);
    expect(ids(await get(`/offers?${q('ARALIK')}`, cookie))).toEqual([requestOffer.id]);
  });

  it('never matches a contact field the caller may not read', async () => {
    const { providerOffer } = await offerWorld();
    const cookie = await sessionWith([AdminPermission.OFFERS_READ]);

    // The business name is on the offer row for every reader; the contact
    // person, the customer's name and both e-mails are not.
    expect(ids(await get(`/offers?${q('ışık tesisat')}`, cookie))).toEqual([providerOffer.id]);
    for (const box of ['ilker', 'ilker ışıkçı', 'ırmak ışın', 'ivan.usta', 'ivan.musteri@example.test']) {
      expect(await get(`/offers?${q(box)}`, cookie), box).toEqual([]);
    }
  });
});

describe('GET /finance/providers and /finance/credit-ledger', () => {
  it('folds the business name and the ledger reason', async () => {
    const { provider } = await offerWorld();
    await ctx.prisma.providerCreditTransaction.updateMany({
      where: { providerId: provider.id },
      data: { reason: 'IĞDIR kampanyası' },
    });
    const cookie = await sessionWith([AdminPermission.FINANCE_READ, AdminPermission.FINANCE_LEDGER_READ]);

    const finance = (await get(`/finance/providers?${q('ışık tesisat')}`, cookie)).items;
    expect(finance.map((row: { provider: { id: string } }) => row.provider.id)).toEqual([provider.id]);

    for (const box of ['ışık', 'ığdır kampanyası']) {
      const ledger = (await get(`/finance/credit-ledger?${q(box)}`, cookie)).items;
      expect(ledger.length, box).toBeGreaterThan(0);
      expect(ledger.every((row: { provider: { id: string } }) => row.provider.id === provider.id), box).toBe(true);
    }
  });

  it('matches the provider e-mail only with PROVIDERS_READ', async () => {
    const { provider } = await offerWorld();
    const without = await sessionWith([AdminPermission.FINANCE_READ, AdminPermission.FINANCE_LEDGER_READ]);
    const withContact = await sessionWith([
      AdminPermission.FINANCE_READ,
      AdminPermission.FINANCE_LEDGER_READ,
      AdminPermission.PROVIDERS_READ,
    ]);

    expect((await get(`/finance/providers?${q('IVAN.USTA')}`, without)).items).toHaveLength(0);
    expect((await get(`/finance/credit-ledger?${q('IVAN.USTA')}`, without)).items).toHaveLength(0);
    const finance = (await get(`/finance/providers?${q('IVAN.USTA')}`, withContact)).items;
    expect(finance.map((row: { provider: { id: string } }) => row.provider.id)).toEqual([provider.id]);
  });
});
