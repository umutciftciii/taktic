import {
  AdminPermission,
  OfferPackageType,
  OfferStatus,
  PackagePurchaseStatus,
  ProviderStatus,
  ServiceRequestReportReason,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminWithPermissions,
  createApprovedRequest,
  createCategory,
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001.
 *
 * A route's permission opens its own subject. Data the subject is joined to —
 * a provider's balance, offers and purchases, a customer's requests and
 * offers, a request owner's contact, the provider's contact on a ledger or
 * purchase row — belongs to that data's own read permission, and an admin
 * response carries it only for a caller holding that permission.
 *
 * Absent means absent: the key is not in the body, and neither is the value
 * anywhere in the serialised JSON. Not `null`, not `0`, not `[]`. SUPER_ADMIN
 * keeps the whole view; the provider's and customer's own routes are untouched.
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

async function sessionWith(permissions: AdminPermission[]) {
  const { admin } = await createAdminWithPermissions(ctx.prisma, permissions);
  return loginAs(ctx.prisma, admin.id);
}

async function superAdminSession() {
  const user = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, user.id);
}

async function get(path: string, cookie: string) {
  const response = await request(ctx.server).get(path).set('Cookie', cookie);
  return response;
}

/**
 * One provider with a balance, one offer on one request of one customer, and
 * one paid purchase: every cross-domain block has a row behind it, so an
 * absent block is the projection's doing and not an empty table's.
 */
async function world() {
  const category = await createCategory(ctx.prisma, `Kategori ${Date.now()}`);
  const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, name: 'Hesap Sahibi' });
  const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
  await grantCredits(ctx.prisma, provider.id, 37);
  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customer.id,
    neighborhood: 'Moda',
  });
  const offer = await ctx.prisma.offer.create({
    data: {
      requestId: serviceRequest.id,
      providerId: provider.id,
      status: OfferStatus.SUBMITTED,
      priceAmount: 250000,
      message: 'Teklifim',
      creditCost: 0,
    },
  });
  const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 25 });
  const purchase = await ctx.prisma.packagePurchase.create({
    data: {
      providerId: provider.id,
      packageId: pkg.id,
      status: PackagePurchaseStatus.PAID,
      creditAmountSnapshot: 25,
      priceAmountSnapshot: pkg.priceAmount,
      packageNameSnapshot: pkg.name,
      paidAt: new Date(),
    },
  });
  return { category, customer, provider, serviceRequest, offer, purchase };
}

const PROVIDER_LIST_FIGURES = ['creditBalance', 'activeOffersCount', 'totalOffersCount', 'packagePurchasesCount'];
const PROVIDER_DETAIL_BLOCKS = [
  'creditBalance',
  'activeOffersCount',
  'totalOffersCount',
  'recentOffers',
  'packagePurchasesCount',
  'recentPackagePurchases',
];

describe('GET /providers (PROVIDERS_READ)', () => {
  it('carries no balance, offer or purchase figure to PROVIDERS_READ alone', async () => {
    const { provider } = await world();
    const response = await get('/providers', await sessionWith([AdminPermission.PROVIDERS_READ]));

    expect(response.status).toBe(200);
    const row = response.body.find((item: { id: string }) => item.id === provider.id);
    for (const key of PROVIDER_LIST_FIGURES) expect(row).not.toHaveProperty(key);
    // The route's own subject is whole: profile, contact.
    expect(row.phone).toBe(provider.phone);
    expect(row.businessName).toBe(provider.businessName);
  });

  it.each([
    [AdminPermission.FINANCE_LEDGER_READ, ['creditBalance']],
    [AdminPermission.OFFERS_READ, ['activeOffersCount', 'totalOffersCount']],
    [AdminPermission.PACKAGE_PURCHASES_READ, ['packagePurchasesCount']],
  ])('adds exactly the figures %s reads', async (permission, keys) => {
    const { provider } = await world();
    const response = await get('/providers', await sessionWith([AdminPermission.PROVIDERS_READ, permission]));

    const row = response.body.find((item: { id: string }) => item.id === provider.id);
    for (const key of PROVIDER_LIST_FIGURES) {
      if (keys.includes(key)) expect(row).toHaveProperty(key);
      else expect(row).not.toHaveProperty(key);
    }
  });

  it('gives SUPER_ADMIN every figure with its value', async () => {
    const { provider } = await world();
    const response = await get('/providers', await superAdminSession());

    const row = response.body.find((item: { id: string }) => item.id === provider.id);
    expect(row).toMatchObject({ creditBalance: 37, activeOffersCount: 1, totalOffersCount: 1, packagePurchasesCount: 1 });
  });
});

describe('GET /providers/:providerId/admin-detail (PROVIDERS_READ_DETAIL)', () => {
  it('carries the profile and claim but no balance, offers or purchases to PROVIDERS_READ_DETAIL alone', async () => {
    const { provider, offer, purchase } = await world();
    const response = await get(
      `/providers/${provider.id}/admin-detail`,
      await sessionWith([AdminPermission.PROVIDERS_READ_DETAIL]),
    );

    expect(response.status).toBe(200);
    for (const key of PROVIDER_DETAIL_BLOCKS) expect(response.body).not.toHaveProperty(key);
    expect(response.body).toHaveProperty('claim');
    expect(response.body.phone).toBe(provider.phone);
    const json = JSON.stringify(response.body);
    expect(json).not.toContain(offer.id);
    expect(json).not.toContain(purchase.id);
  });

  it.each([
    [AdminPermission.FINANCE_LEDGER_READ, ['creditBalance']],
    [AdminPermission.OFFERS_READ, ['activeOffersCount', 'totalOffersCount', 'recentOffers']],
    [AdminPermission.PACKAGE_PURCHASES_READ, ['packagePurchasesCount', 'recentPackagePurchases']],
  ])('adds exactly the blocks %s reads', async (permission, keys) => {
    const { provider } = await world();
    const response = await get(
      `/providers/${provider.id}/admin-detail`,
      await sessionWith([AdminPermission.PROVIDERS_READ_DETAIL, permission]),
    );

    expect(response.status).toBe(200);
    for (const key of PROVIDER_DETAIL_BLOCKS) {
      if (keys.includes(key)) expect(response.body).toHaveProperty(key);
      else expect(response.body).not.toHaveProperty(key);
    }
  });

  it('gives SUPER_ADMIN the whole page', async () => {
    const { provider, offer, purchase } = await world();
    const response = await get(`/providers/${provider.id}/admin-detail`, await superAdminSession());

    expect(response.body).toMatchObject({
      creditBalance: 37,
      activeOffersCount: 1,
      totalOffersCount: 1,
      packagePurchasesCount: 1,
    });
    expect(response.body.recentOffers.map((row: { id: string }) => row.id)).toEqual([offer.id]);
    expect(response.body.recentPackagePurchases.map((row: { id: string }) => row.id)).toEqual([purchase.id]);
  });
});

describe('GET /providers/:id — the staff projection follows PROVIDERS_READ', () => {
  it('reads as the public does for a staff account without PROVIDERS_READ', async () => {
    const approved = await createProviderProfile(ctx.prisma, { status: ProviderStatus.APPROVED });
    const pending = await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });
    const cookie = await sessionWith([AdminPermission.SUPPORT_READ]);

    const response = await get(`/providers/${approved.id}`, cookie);
    expect(response.status).toBe(200);
    expect(response.body.visibility).toBe('public');
    expect(JSON.stringify(response.body)).not.toContain(approved.phone);
    expect(response.body).not.toHaveProperty('moderationNote');

    expect((await get(`/providers/${pending.id}`, cookie)).status).toBe(404);
  });

  it('keeps the operator projection for PROVIDERS_READ and for SUPER_ADMIN', async () => {
    const pending = await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    for (const cookie of [await sessionWith([AdminPermission.PROVIDERS_READ]), await superAdminSession()]) {
      const response = await get(`/providers/${pending.id}`, cookie);
      expect(response.status).toBe(200);
      expect(response.body.visibility).toBe('admin');
      expect(response.body.phone).toBe(pending.phone);
    }
  });
});

describe('GET /customers/:id (CUSTOMERS_READ)', () => {
  it('carries the account and no request or offer block to CUSTOMERS_READ alone', async () => {
    const { customer, serviceRequest, offer } = await world();
    const response = await get(`/customers/${customer.id}`, await sessionWith([AdminPermission.CUSTOMERS_READ]));

    expect(response.status).toBe(200);
    expect(response.body.customer.id).toBe(customer.id);
    expect(response.body.customer.phone).toBe(customer.phone);
    expect(response.body.metrics).toEqual({});
    for (const key of ['recentRequests', 'recentOffers', 'acceptedOffers']) {
      expect(response.body).not.toHaveProperty(key);
    }
    const json = JSON.stringify(response.body);
    expect(json).not.toContain(serviceRequest.id);
    expect(json).not.toContain(offer.id);
  });

  it('adds the requests and their figures for REQUESTS_READ', async () => {
    const { customer, serviceRequest, offer } = await world();
    const response = await get(
      `/customers/${customer.id}`,
      await sessionWith([AdminPermission.CUSTOMERS_READ, AdminPermission.REQUESTS_READ]),
    );

    expect(Object.keys(response.body.metrics).sort()).toEqual(['lastRequestAt', 'requestCount']);
    expect(response.body.metrics.requestCount).toBe(1);
    expect(response.body.recentRequests.map((row: { id: string }) => row.id)).toEqual([serviceRequest.id]);
    expect(response.body).not.toHaveProperty('recentOffers');
    expect(response.body).not.toHaveProperty('acceptedOffers');
    expect(JSON.stringify(response.body)).not.toContain(offer.id);
  });

  it('adds the offers and their figures for OFFERS_READ', async () => {
    const { customer, serviceRequest, offer } = await world();
    const response = await get(
      `/customers/${customer.id}`,
      await sessionWith([AdminPermission.CUSTOMERS_READ, AdminPermission.OFFERS_READ]),
    );

    expect(Object.keys(response.body.metrics).sort()).toEqual(['acceptedOfferCount', 'offerCount']);
    expect(response.body.recentOffers.map((row: { id: string }) => row.id)).toEqual([offer.id]);
    expect(response.body.acceptedOffers).toEqual([]);
    expect(response.body).not.toHaveProperty('recentRequests');
    // The offer row names its request by number, the way the offer list does.
    expect(response.body.recentOffers[0].requestNumber).toBe(serviceRequest.requestNumber);
  });

  it('gives SUPER_ADMIN the whole page', async () => {
    const { customer } = await world();
    const response = await get(`/customers/${customer.id}`, await superAdminSession());

    expect(response.body.metrics).toMatchObject({ requestCount: 1, offerCount: 1, acceptedOfferCount: 0 });
    expect(response.body.recentRequests).toHaveLength(1);
    expect(response.body.recentOffers).toHaveLength(1);
    expect(response.body.acceptedOffers).toEqual([]);
  });
});

describe('GET /customers (CUSTOMERS_READ)', () => {
  const REQUEST_FIGURES = ['requestCount', 'lastRequestAt', 'lastRequestCity'];
  const OFFER_FIGURES = ['offerCount', 'acceptedOfferCount'];

  it('lists the accounts without request or offer figures, newest account first', async () => {
    const { customer } = await world();
    const response = await get('/customers', await sessionWith([AdminPermission.CUSTOMERS_READ]));

    expect(response.status).toBe(200);
    const row = response.body.items.find((item: { id: string }) => item.id === customer.id);
    expect(row.email).toBe(customer.email);
    for (const key of [...REQUEST_FIGURES, ...OFFER_FIGURES]) expect(row).not.toHaveProperty(key);
    expect(response.body.meta).toEqual({});
  });

  it.each([
    ['sortBy=lastRequestAt'],
    ['sortBy=requestCount'],
    ['city=%C4%B0stanbul'],
    ['lastRequestFrom=2026-01-01'],
    ['sortBy=offerCount'],
  ])('refuses %s to a caller without the figure behind it', async (query) => {
    const response = await get(`/customers?${query}`, await sessionWith([AdminPermission.CUSTOMERS_READ]));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('adds each domain’s figures — and its sorts — with its permission only', async () => {
    const { customer } = await world();
    const withRequests = await sessionWith([AdminPermission.CUSTOMERS_READ, AdminPermission.REQUESTS_READ]);

    const response = await get('/customers?sortBy=requestCount&city=%C4%B0stanbul', withRequests);
    expect(response.status).toBe(200);
    const row = response.body.items.find((item: { id: string }) => item.id === customer.id);
    for (const key of REQUEST_FIGURES) expect(row).toHaveProperty(key);
    for (const key of OFFER_FIGURES) expect(row).not.toHaveProperty(key);
    expect(response.body.meta).toHaveProperty('anonymousRequestCount');

    expect((await get('/customers?sortBy=offerCount', withRequests)).status).toBe(403);
    const withOffers = await get(
      '/customers?sortBy=offerCount',
      await sessionWith([AdminPermission.CUSTOMERS_READ, AdminPermission.OFFERS_READ]),
    );
    expect(withOffers.status).toBe(200);
    expect(withOffers.body.items.find((item: { id: string }) => item.id === customer.id)).toMatchObject({
      offerCount: 1,
      acceptedOfferCount: 0,
    });
  });

  it('gives SUPER_ADMIN every figure', async () => {
    const { customer } = await world();
    const response = await get('/customers', await superAdminSession());

    const row = response.body.items.find((item: { id: string }) => item.id === customer.id);
    expect(row).toMatchObject({ requestCount: 1, offerCount: 1, acceptedOfferCount: 0, lastRequestCity: 'İstanbul' });
  });
});

describe('GET /offers and /offers/:id (OFFERS_READ)', () => {
  it('names the provider and the request but carries neither contact to OFFERS_READ alone', async () => {
    const { offer, provider, serviceRequest, customer } = await world();
    const cookie = await sessionWith([AdminPermission.OFFERS_READ]);

    for (const body of [(await get(`/offers/${offer.id}`, cookie)).body, (await get('/offers', cookie)).body[0]]) {
      expect(body.id).toBe(offer.id);
      expect(Object.keys(body.provider).sort()).toEqual(['businessName', 'city', 'district', 'id', 'status']);
      expect(Object.keys(body.request).sort()).toEqual([
        'category',
        'city',
        'customerId',
        'district',
        'id',
        'requestNumber',
        'status',
      ]);
      expect(body.request.customerId).toBe(customer.id);
      const json = JSON.stringify(body);
      for (const secret of [
        provider.phone,
        provider.email!,
        provider.contactName,
        serviceRequest.customerPhone,
        serviceRequest.customerEmail!,
        serviceRequest.customerName,
        customer.email!,
      ]) {
        expect(json).not.toContain(secret);
      }
    }
  });

  it.each([
    [AdminPermission.PROVIDERS_READ, 'provider', ['contactName', 'phone', 'email']],
    [AdminPermission.REQUESTS_READ, 'request', ['neighborhood', 'qualityScore', 'customerName', 'customerPhone', 'customerEmail']],
    [AdminPermission.CUSTOMERS_READ, 'request', ['customer']],
  ])('adds the %s block', async (permission, side, keys) => {
    const { offer } = await world();
    const response = await get(`/offers/${offer.id}`, await sessionWith([AdminPermission.OFFERS_READ, permission]));

    for (const key of keys) expect(response.body[side]).toHaveProperty(key);
  });

  it('does not let a search confirm a contact the caller may not read', async () => {
    const { serviceRequest, provider } = await world();
    const offersOnly = await sessionWith([AdminPermission.OFFERS_READ]);
    const withContact = await sessionWith([
      AdminPermission.OFFERS_READ,
      AdminPermission.REQUESTS_READ,
      AdminPermission.PROVIDERS_READ,
    ]);

    for (const term of [serviceRequest.customerPhone, provider.phone]) {
      const query = `/offers?q=${encodeURIComponent(term)}`;
      expect((await get(query, offersOnly)).body).toHaveLength(0);
      expect((await get(query, withContact)).body).toHaveLength(1);
    }
  });

  it('gives SUPER_ADMIN the whole offer', async () => {
    const { offer, serviceRequest, customer, provider } = await world();
    const response = await get(`/offers/${offer.id}`, await superAdminSession());

    expect(response.body.provider.phone).toBe(provider.phone);
    expect(response.body.request.customerPhone).toBe(serviceRequest.customerPhone);
    expect(response.body.request.neighborhood).toBe('Moda');
    expect(response.body.request.customer.id).toBe(customer.id);
  });
});

describe('GET /service-requests and /service-requests/:id (REQUESTS_READ)', () => {
  it('keeps the request and its contact snapshot but not the customer account', async () => {
    const { serviceRequest, customer } = await world();
    const cookie = await sessionWith([AdminPermission.REQUESTS_READ]);

    const detail = await get(`/service-requests/${serviceRequest.id}`, cookie);
    const list = (await get('/service-requests', cookie)).body.find((row: { id: string }) => row.id === serviceRequest.id);

    for (const body of [detail.body, list]) {
      expect(body.customerPhone).toBe(serviceRequest.customerPhone);
      expect(body.customerId).toBe(customer.id);
      expect(body).not.toHaveProperty('customer');
      expect(JSON.stringify(body)).not.toContain(customer.email!);
    }
    expect(list.offersCount).toBe(1);
  });

  it('adds the account for CUSTOMERS_READ and for SUPER_ADMIN', async () => {
    const { serviceRequest, customer } = await world();
    for (const cookie of [
      await sessionWith([AdminPermission.REQUESTS_READ, AdminPermission.CUSTOMERS_READ]),
      await superAdminSession(),
    ]) {
      const detail = await get(`/service-requests/${serviceRequest.id}`, cookie);
      expect(detail.body.customer).toEqual({
        id: customer.id,
        email: customer.email,
        phone: customer.phone,
        name: customer.name,
      });
    }
  });
});

describe('POST /service-requests/:id/reports/resolve (REQUEST_REPORTS_RESOLVE)', () => {
  async function reported() {
    const { serviceRequest, provider } = await world();
    await ctx.prisma.serviceRequestReport.create({
      data: { requestId: serviceRequest.id, reporterProviderId: provider.id, reason: ServiceRequestReportReason.SPAM },
    });
    return serviceRequest;
  }

  it('answers the resolver without REQUESTS_READ with the request reference only', async () => {
    const serviceRequest = await reported();
    const response = await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/reports/resolve`)
      .set('Cookie', await sessionWith([AdminPermission.REQUEST_REPORTS_RESOLVE]))
      .send({ resolution: 'DISMISSED' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: serviceRequest.id,
      requestNumber: serviceRequest.requestNumber,
      status: 'APPROVED',
    });
  });

  it('answers a resolver holding REQUESTS_READ with the request page', async () => {
    const serviceRequest = await reported();
    const response = await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/reports/resolve`)
      .set('Cookie', await sessionWith([AdminPermission.REQUEST_REPORTS_RESOLVE, AdminPermission.REQUESTS_READ]))
      .send({ resolution: 'DISMISSED' });

    expect(response.status).toBe(201);
    expect(response.body.customerPhone).toBe(serviceRequest.customerPhone);
    expect(response.body).not.toHaveProperty('customer');
  });
});

describe('finance lists name the provider; its contact is PROVIDERS_READ’s', () => {
  it('leaves the phone and e-mail out of /finance/providers and /finance/credit-ledger, and out of their search', async () => {
    const { provider } = await world();
    const financeOnly = await sessionWith([AdminPermission.FINANCE_READ, AdminPermission.FINANCE_LEDGER_READ]);

    const finance = await get('/finance/providers', financeOnly);
    const ledger = await get('/finance/credit-ledger', financeOnly);
    const financeRow = finance.body.items.find((row: { provider: { id: string } }) => row.provider.id === provider.id);
    const ledgerRow = ledger.body.items.find((row: { provider: { id: string } }) => row.provider.id === provider.id);

    expect(Object.keys(financeRow.provider).sort()).toEqual(['businessName', 'id', 'status']);
    expect(Object.keys(ledgerRow.provider).sort()).toEqual(['businessName', 'id']);
    expect(JSON.stringify([finance.body, ledger.body])).not.toContain(provider.phone);

    const phone = encodeURIComponent(provider.phone);
    expect((await get(`/finance/providers?q=${phone}`, financeOnly)).body.items).toHaveLength(0);
    expect((await get(`/finance/credit-ledger?q=${phone}`, financeOnly)).body.items).toHaveLength(0);
  });

  it('carries and searches the contact with PROVIDERS_READ', async () => {
    const { provider } = await world();
    const cookie = await sessionWith([
      AdminPermission.FINANCE_READ,
      AdminPermission.FINANCE_LEDGER_READ,
      AdminPermission.PROVIDERS_READ,
    ]);
    const phone = encodeURIComponent(provider.phone);

    const finance = await get(`/finance/providers?q=${phone}`, cookie);
    const ledger = await get(`/finance/credit-ledger?q=${phone}`, cookie);
    expect(finance.body.items[0].provider).toMatchObject({ phone: provider.phone, email: provider.email });
    expect(ledger.body.items[0].provider).toMatchObject({ phone: provider.phone, email: provider.email });
  });
});

describe('GET /package-purchases (PACKAGE_PURCHASES_READ)', () => {
  async function heldPurchase() {
    const scene = await world();
    const event = await ctx.prisma.paymentWebhookEvent.create({
      data: {
        provider: 'lemon-squeezy-test',
        eventKey: `order_created:${scene.purchase.id}`,
        eventName: 'order_created',
        status: 'PROCESSED',
        purchaseId: scene.purchase.id,
      },
    });
    await ctx.prisma.packagePurchaseCreditHold.create({
      data: {
        purchaseId: scene.purchase.id,
        providerId: scene.provider.id,
        reason: 'CREDIT_BALANCE_LIMIT_EXCEEDED',
        providerOrderId: 'order-1',
        chargedAmountMinor: 49900,
        currency: 'TRY',
        creditAmount: 25,
        balanceAtOpen: 4242,
        openedEventId: event.id,
      },
    });
    return scene;
  }

  it('names the provider without its contact, and keeps the balance at hold out, for PACKAGE_PURCHASES_READ alone', async () => {
    const { purchase, provider } = await heldPurchase();
    const cookie = await sessionWith([AdminPermission.PACKAGE_PURCHASES_READ]);

    const list = await get('/package-purchases', cookie);
    const detail = await get(`/package-purchases/${purchase.id}`, cookie);
    expect(detail.status).toBe(200);
    for (const body of [list.body[0], detail.body]) {
      expect(body.provider).not.toHaveProperty('contactName');
      expect(body.provider).not.toHaveProperty('email');
      expect(body.provider.businessName).toBe(provider.businessName);
    }
    expect(detail.body.creditHold).not.toHaveProperty('balanceAtOpen');
    expect(detail.body.creditHold.creditAmount).toBe(25);
    expect(JSON.stringify(detail.body)).not.toContain(provider.contactName);
  });

  it('adds the contact with PROVIDERS_READ and the balance with FINANCE_LEDGER_READ; SUPER_ADMIN reads both', async () => {
    const { purchase, provider } = await heldPurchase();
    const both = await sessionWith([
      AdminPermission.PACKAGE_PURCHASES_READ,
      AdminPermission.PROVIDERS_READ,
      AdminPermission.FINANCE_LEDGER_READ,
    ]);

    for (const cookie of [both, await superAdminSession()]) {
      const detail = await get(`/package-purchases/${purchase.id}`, cookie);
      expect(detail.body.provider).toMatchObject({ contactName: provider.contactName, email: provider.email });
      expect(detail.body.creditHold.balanceAtOpen).toBe(4242);
    }
  });
});

describe('the provider’s and the customer’s own reads are not projected', () => {
  it('still gives the provider its own balance, purchases and contact', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    await grantCredits(ctx.prisma, provider.id, 12);
    const pkg = await createOfferPackage(ctx.prisma, { type: OfferPackageType.ONE_TIME_CREDITS, creditAmount: 25 });
    await ctx.prisma.packagePurchase.create({
      data: {
        providerId: provider.id,
        packageId: pkg.id,
        status: PackagePurchaseStatus.PAID,
        creditAmountSnapshot: 25,
        priceAmountSnapshot: pkg.priceAmount,
        packageNameSnapshot: pkg.name,
        paidAt: new Date(),
      },
    });
    const cookie = await loginAs(ctx.prisma, owner.id);

    const dashboard = await get('/providers/me/dashboard', cookie);
    expect(dashboard.body.creditBalance).toBe(12);

    const own = await get(`/providers/${provider.id}`, cookie);
    expect(own.body.visibility).toBe('owner');
    expect(own.body.phone).toBe(provider.phone);

    const purchases = await get(`/providers/${provider.id}/package-purchases`, cookie);
    expect(purchases.status).toBe(200);
    expect(purchases.body[0].provider).toMatchObject({ contactName: provider.contactName, email: provider.email });
  });

  it('still refuses the provider every admin route touched here', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
    const cookie = await loginAs(ctx.prisma, owner.id);

    for (const path of [
      '/providers',
      `/providers/${provider.id}/admin-detail`,
      '/customers',
      '/offers',
      '/service-requests',
      '/finance/providers',
      '/package-purchases',
    ]) {
      expect((await get(path, cookie)).status).toBe(403);
    }
  });
});
