import { PackagePurchaseStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LemonSqueezyCheckoutAdapter,
  LemonSqueezyFetch,
  LemonSqueezyResponse,
} from '../src/modules/payments/lemon-squeezy.adapter';
import { MockPaymentAdapter } from '../src/modules/payments/mock-payment.adapter';
import { PaymentProviderPort } from '../src/modules/payments/payment-provider.port';
import {
  createProviderProfile,
  createTestApp,
  createUser,
  currentCreditBalance,
  loginAs,
  resetDatabase,
  uniqueSuffix,
  type TestContext,
} from './harness';

/**
 * Opening a checkout, over HTTP, against the real application graph.
 *
 * No test in this file may reach the network: the sandbox adapter is
 * constructed with a stand-in for `fetch` in every case, and the credentials
 * below are syntactically valid placeholders that were never issued.
 *
 * What the file is about is the boundary between what a client may say and what
 * the server decides. A browser names a package; everything that matters — who
 * may buy, how many credits, at what price, in which currency, and against
 * which correlation token — is resolved here and written down before anybody is
 * sent anywhere.
 */
const PLACEHOLDER_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'placeholderNotARealCredential'}`;
const PLACEHOLDER_WEBHOOK_SECRET = 'placeholder-webhook-secret-not-real';
const STORE_ID = '424242';
const VARIANT_ID = '778899';
const HOSTED_URL = 'https://taktic-sandbox.lemonsqueezy.test/checkout/abc123';

type Call = { input: string; init: Parameters<LemonSqueezyFetch>[1] };

function recordingFetch(respond: (call: Call) => LemonSqueezyResponse) {
  const calls: Call[] = [];
  const fetchImpl: LemonSqueezyFetch = async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return respond(call);
  };

  return { calls, fetchImpl };
}

function checkoutResponse(
  status = 201,
  body: unknown = {
    data: {
      type: 'checkouts',
      id: 'checkout-abc-123',
      attributes: { url: HOSTED_URL, expires_at: '2099-01-01T00:00:00.000Z' },
    },
  },
): LemonSqueezyResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const MANAGED_KEYS = [
  'PAYMENT_PROVIDER',
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
  'WEB_ORIGIN',
] as const;

let original: Record<string, string | undefined>;

function configureLemonSqueezy(packageSlug: string) {
  process.env.PAYMENT_PROVIDER = 'lemon-squeezy-test';
  process.env.LEMON_SQUEEZY_API_KEY = PLACEHOLDER_API_KEY;
  process.env.LEMON_SQUEEZY_STORE_ID = STORE_ID;
  process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = PLACEHOLDER_WEBHOOK_SECRET;
  process.env.LEMON_SQUEEZY_VARIANT_MAP = `${packageSlug}:${VARIANT_ID}`;
  process.env.WEB_ORIGIN = 'https://web.example.test';
}

let ctx: TestContext;
let calls: Call[];
let respond: (call: Call) => LemonSqueezyResponse;

beforeAll(async () => {
  const recorder = recordingFetch((call) => respond(call));
  calls = recorder.calls;

  // The real adapter, with a stand-in transport. The application still decides
  // which adapter to bind from PAYMENT_PROVIDER on every request-scoped read;
  // this only stops the outbound socket.
  ctx = await createTestApp({
    paymentProvider: new LemonSqueezyCheckoutAdapter(recorder.fetchImpl),
  });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  calls.length = 0;
  respond = () => checkoutResponse();

  original = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** An approved provider owned by a signed-in PROVIDER account, plus a package. */
async function checkoutFixture(
  options: { creditAmount?: number; priceAmount?: number; currency?: string } = {},
) {
  const suffix = uniqueSuffix();
  const slug = `paket-${suffix}`;
  const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: ownerUser.id });
  const creditPackage = await ctx.prisma.offerCreditPackage.create({
    data: {
      name: `Paket ${suffix}`,
      slug,
      creditAmount: options.creditAmount ?? 25,
      priceAmount: options.priceAmount ?? 49900,
      currency: options.currency ?? 'TRY',
      isActive: true,
    },
  });

  configureLemonSqueezy(slug);

  return {
    ownerUser,
    provider,
    creditPackage,
    slug,
    cookie: await loginAs(ctx.prisma, ownerUser.id),
  };
}

describe('who may open a checkout', () => {
  it('refuses an anonymous caller', async () => {
    const { provider, creditPackage } = await checkoutFixture();

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .send({ packageId: creditPackage.id })
      .expect(401);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('refuses a customer account', async () => {
    const { provider, creditPackage } = await checkoutFixture();
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(403);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('refuses another provider account', async () => {
    const { provider, creditPackage } = await checkoutFixture();
    const otherUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, { userId: otherUser.id });
    const cookie = await loginAs(ctx.prisma, otherUser.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(403);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('refuses a SUPER_ADMIN, who has the audited grant endpoint instead', async () => {
    const { provider, creditPackage } = await checkoutFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const cookie = await loginAs(ctx.prisma, admin.id);

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(403);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });
});

describe('the server decides what is being bought', () => {
  it('snapshots the package the database holds and ignores anything else in the body', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture({
      creditAmount: 25,
      priceAmount: 49900,
    });

    // Every extra field is a manipulation attempt, and the global validation
    // pipe rejects the request outright rather than quietly dropping them.
    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({
        packageId: creditPackage.id,
        creditAmount: 100000,
        priceAmount: 1,
        currency: 'USD',
        status: 'PAID',
      })
      .expect(400);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    expect(response.body.purchase.creditAmountSnapshot).toBe(25);
    expect(response.body.purchase.priceAmountSnapshot).toBe(49900);
    expect(response.body.purchase.currencySnapshot).toBe('TRY');
    expect(response.body.purchase.status).toBe('PENDING');

    // The amount the provider is asked for is this application's own snapshot,
    // not whatever the sandbox variant happens to be priced at today.
    const body = JSON.parse(calls[0]!.init.body) as {
      data: { attributes: { custom_price: number; test_mode: boolean } };
    };
    expect(body.data.attributes.custom_price).toBe(49900);
    expect(body.data.attributes.test_mode).toBe(true);
  });

  it('refuses an inactive package and an unknown one, opening nothing', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();
    await ctx.prisma.offerCreditPackage.update({
      where: { id: creditPackage.id },
      data: { isActive: false },
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(400);

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: 'no-such-package' })
      .expect(400);

    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('refuses a package that is not mapped to a sandbox variant', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();
    process.env.LEMON_SQUEEZY_VARIANT_MAP = 'some-other-package:999';

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(503);

    expect(calls).toHaveLength(0);

    // The purchase does not linger as an unpayable PENDING row.
    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.FAILED);
    expect(purchase.paymentFailureCode).toBe('PACKAGE_NOT_MAPPED');
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });
});

describe('the pending purchase and its correlation token', () => {
  it('records the provider kind, an opaque reference and the hosted session', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    expect(response.body.checkout).toMatchObject({
      provider: 'lemon-squeezy-test',
      mode: 'test',
      url: HOSTED_URL,
      reused: false,
    });

    // The token never appears in an API response, provider's own or otherwise.
    expect(response.body.purchase.paymentReference).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('paymentReference');

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.PENDING);
    expect(purchase.paymentProvider).toBe('lemon-squeezy-test');
    expect(purchase.paymentReference).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(purchase.providerCheckoutId).toBe('checkout-abc-123');
    expect(purchase.providerCheckoutUrl).toBe(HOSTED_URL);
    expect(purchase.providerOrderId).toBeNull();

    // The token travels as checkout metadata and nowhere else, and the return
    // URL — which a browser can read — deliberately does not carry it.
    const body = JSON.parse(calls[0]!.init.body) as {
      data: {
        attributes: {
          checkout_data: { custom: { purchase_reference: string } };
          product_options: { redirect_url: string; name: string; description: string };
        };
        relationships: { store: { data: { id: string } }; variant: { data: { id: string } } };
      };
    };
    expect(body.data.attributes.checkout_data.custom.purchase_reference).toBe(
      purchase.paymentReference,
    );
    expect(body.data.attributes.product_options.redirect_url).toBe(
      `https://web.example.test/providers/${provider.id}/package-purchases/${purchase.id}?checkout=return`,
    );
    expect(body.data.attributes.product_options.redirect_url).not.toContain(
      purchase.paymentReference as string,
    );
    expect(body.data.relationships.store.data.id).toBe(STORE_ID);
    expect(body.data.relationships.variant.data.id).toBe(VARIANT_ID);

    // The line item says what it is: software usage credit for the provider's
    // own account, not a service and not a transfer to anybody.
    expect(body.data.attributes.product_options.name).toContain('software usage credits');
    expect(body.data.attributes.product_options.description).toContain(
      'not a service purchase',
    );

    // Nothing about the buyer travels.
    const raw = calls[0]!.init.body;
    expect(raw).not.toContain(provider.email as string);
    expect(raw).not.toContain(provider.businessName);
    expect(raw).not.toContain(provider.phone);
  });

  it('mints a distinct reference per purchase', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    respond = () =>
      checkoutResponse(201, {
        data: {
          type: 'checkouts',
          id: `checkout-${calls.length}`,
          attributes: { url: `${HOSTED_URL}-${calls.length}` },
        },
      });

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    // The first session is expired by hand, so the reuse branch cannot apply.
    await ctx.prisma.packagePurchase.updateMany({
      data: { providerCheckoutExpiresAt: new Date(Date.now() - 60_000) },
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    const references = (await ctx.prisma.packagePurchase.findMany()).map(
      (purchase) => purchase.paymentReference,
    );
    expect(references).toHaveLength(2);
    expect(new Set(references).size).toBe(2);
  });

  it('hands the live session back instead of opening a second one', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    const first = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    const second = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    expect(second.body.purchase.id).toBe(first.body.purchase.id);
    expect(second.body.checkout.url).toBe(first.body.checkout.url);
    expect(second.body.checkout.reused).toBe(true);

    // One purchase, one call to the provider.
    expect(calls).toHaveLength(1);
    expect(await ctx.prisma.packagePurchase.count()).toBe(1);
  });

  it('opens a fresh session once the previous one has expired', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    await ctx.prisma.packagePurchase.updateMany({
      data: { providerCheckoutExpiresAt: new Date(Date.now() - 60_000) },
    });

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    expect(calls).toHaveLength(2);
    expect(await ctx.prisma.packagePurchase.count()).toBe(2);
  });
});

describe('the checkout URL belongs to one provider', () => {
  it('is not readable through another account', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(201);

    const purchaseId = created.body.purchase.id as string;

    const otherUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, { userId: otherUser.id });
    const otherCookie = await loginAs(ctx.prisma, otherUser.id);

    await request(ctx.server)
      .get(`/providers/${provider.id}/package-purchases/${purchaseId}`)
      .set('Cookie', otherCookie)
      .expect(403);

    const own = await request(ctx.server)
      .get(`/providers/${provider.id}/package-purchases/${purchaseId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(own.body.providerCheckoutUrl).toBe(HOSTED_URL);
  });
});

describe('a provider failure never leaves a payable purchase behind', () => {
  it('marks the purchase FAILED with a code, never a response body', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    respond = () =>
      checkoutResponse(422, {
        errors: [{ detail: `Invalid variant for store ${STORE_ID} (${PLACEHOLDER_API_KEY})` }],
      });

    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(503);

    expect(JSON.stringify(response.body)).not.toContain(PLACEHOLDER_API_KEY);

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.FAILED);
    expect(purchase.paymentFailureCode).toBe('PROVIDER_REJECTED');
    expect(purchase.providerCheckoutUrl).toBeNull();
    expect(await currentCreditBalance(ctx.prisma, provider.id)).toBe(0);
  });

  it('refuses a response whose checkout URL is not a safe absolute URL', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture();

    respond = () =>
      checkoutResponse(201, {
        data: {
          type: 'checkouts',
          id: 'checkout-hostile',
          attributes: { url: 'javascript:alert(1)' },
        },
      });

    await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: creditPackage.id })
      .expect(503);

    const purchase = await ctx.prisma.packagePurchase.findFirstOrThrow();
    expect(purchase.status).toBe(PackagePurchaseStatus.FAILED);
    expect(purchase.paymentFailureCode).toBe('PROVIDER_RESPONSE_INVALID');
  });
});

describe('what the screens are allowed to read about the configuration', () => {
  it('tells a provider the mode and nothing else', async () => {
    const { cookie } = await checkoutFixture();

    const response = await request(ctx.server)
      .get('/payments/mode')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toEqual({
      provider: 'lemon-squeezy-test',
      mode: 'test',
      liveEnabled: false,
    });
    expect(JSON.stringify(response.body)).not.toContain(PLACEHOLDER_API_KEY);
    expect(JSON.stringify(response.body)).not.toContain(PLACEHOLDER_WEBHOOK_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(STORE_ID);
  });

  it('tells an admin which settings are missing, by name only', async () => {
    await checkoutFixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const ready = await request(ctx.server)
      .get('/payments/config')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(ready.body.ready).toBe(true);
    expect(ready.body.liveEnabled).toBe(false);
    expect(ready.body.missingConfig).toEqual([]);
    expect(JSON.stringify(ready.body)).not.toContain(PLACEHOLDER_API_KEY);
    expect(JSON.stringify(ready.body)).not.toContain(PLACEHOLDER_WEBHOOK_SECRET);

    delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

    const incomplete = await request(ctx.server)
      .get('/payments/config')
      .set('Cookie', adminCookie)
      .expect(200);

    expect(incomplete.body.ready).toBe(false);
    expect(incomplete.body.missingConfig).toEqual(['LEMON_SQUEEZY_WEBHOOK_SECRET']);
  });

  it('is closed to a provider account', async () => {
    const { cookie } = await checkoutFixture();

    await request(ctx.server).get('/payments/config').set('Cookie', cookie).expect(403);
    await request(ctx.server).get('/payments/mode').expect(401);
  });
});

describe('the mock provider keeps its own behaviour', () => {
  it('binds the mock adapter by default and the sandbox one only when asked', async () => {
    // The unoverridden graph, both ways round. Constructing an adapter reads no
    // credential and opens no socket, so this is the whole of the switch.
    process.env.PAYMENT_PROVIDER = 'mock';
    const mockApp = await createTestApp();
    expect(mockApp.app.get(PaymentProviderPort)).toBeInstanceOf(MockPaymentAdapter);
    await mockApp.app.close();

    configureLemonSqueezy('paket-x');
    const sandboxApp = await createTestApp();
    expect(sandboxApp.app.get(PaymentProviderPort)).toBeInstanceOf(LemonSqueezyCheckoutAdapter);
    await sandboxApp.app.close();
  });

  it('opens an in-app checkout with no hosted page and still settles through mock-pay', async () => {
    const { provider, creditPackage, cookie } = await checkoutFixture({ creditAmount: 40 });
    process.env.PAYMENT_PROVIDER = 'mock';

    // The bound port is the sandbox double for this app, so the mock branch is
    // exercised through its own adapter instance rather than the override.
    const mockCtx = await createTestApp({ paymentProvider: new MockPaymentAdapter() });

    try {
      const created = await request(mockCtx.server)
        .post(`/providers/${provider.id}/checkout-sessions`)
        .set('Cookie', cookie)
        .send({ packageId: creditPackage.id })
        .expect(201);

      expect(created.body.checkout).toMatchObject({ provider: 'mock', mode: 'test', url: null });

      const purchaseId = created.body.purchase.id as string;

      const paid = await request(mockCtx.server)
        .post(`/providers/${provider.id}/package-purchases/${purchaseId}/mock-pay`)
        .set('Cookie', cookie)
        .send({
          cardholderName: 'Test Kullanıcısı',
          cardNumber: '4242424242424242',
          expiryMonth: 12,
          expiryYear: new Date().getFullYear() + 3,
          cvv: '123',
        })
        .expect(201);

      expect(paid.body.status).toBe('PAID');
      expect(paid.body.mockPaymentReference).toMatch(/^MOCK-/);
      expect(await currentCreditBalance(mockCtx.prisma, provider.id)).toBe(40);
      expect(calls).toHaveLength(0);
    } finally {
      await mockCtx.app.close();
    }
  });
});
