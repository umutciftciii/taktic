import {
  PackagePurchaseKind,
  PackagePurchaseStatus,
  Prisma,
  SourceChannel,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockPaymentAdapter } from '../src/modules/payments/mock-payment.adapter';
import type {
  CheckoutSession,
  CheckoutSessionRequest,
} from '../src/modules/payments/payment-provider.port';
import { PURCHASE_TERMS_DOCUMENT_SET } from '../src/modules/purchase-terms/purchase-terms.documents';
import {
  buildPurchaseTermsSnapshot,
  sha256Hex,
} from '../src/modules/purchase-terms/purchase-terms.snapshot';
import {
  createOfferPackage,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * CMP-006 PR-A — purchase-terms acceptance evidence at the credit-package
 * checkout, over HTTP and at the database.
 *
 * Three questions, one describe each:
 *
 * 1. With the release gate closed (the default everywhere), is the checkout
 *    exactly what it was? Same responses, same rows, no evidence written.
 * 2. With it open, is every new purchase born with an acceptance of the served
 *    text — and refused without one — while nothing about that acceptance
 *    leaks into any purchase projection, list or public response?
 * 3. Does the database hold the invariants on its own, against writes that
 *    skip the service: requirement ⇔ evidence, one acceptance per purchase and
 *    never another's, append-only, digest bound to text, and no forged
 *    timestamp that opens a way around any of it?
 */

const TERMS = PURCHASE_TERMS_DOCUMENT_SET;
const SNAPSHOT = buildPurchaseTermsSnapshot(TERMS);
const CANARY_UA = 'Mozilla/5.0 (TakTicCanaryAgent/9.9)';

/** A mock adapter that does have a hosted page, so a pending checkout can be reused. */
class HostedMockAdapter extends MockPaymentAdapter {
  opened = 0;
  override async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    this.opened += 1;
    return {
      provider: this.kind,
      url: `https://checkout.example.test/${request.purchaseId}`,
      providerCheckoutId: `co-${request.purchaseId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }
}

let ctx: TestContext;
let adapter: HostedMockAdapter;
let originalGate: string | undefined;

beforeAll(async () => {
  adapter = new HostedMockAdapter();
  ctx = await createTestApp({ paymentProvider: adapter });
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  adapter.opened = 0;
  originalGate = process.env.PURCHASE_TERMS_GATE;
  delete process.env.PURCHASE_TERMS_GATE;
});

afterEach(() => {
  if (originalGate === undefined) delete process.env.PURCHASE_TERMS_GATE;
  else process.env.PURCHASE_TERMS_GATE = originalGate;
});

function openGate() {
  process.env.PURCHASE_TERMS_GATE = 'on';
}

async function fixture() {
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createProviderProfile(ctx.prisma, { userId: owner.id });
  const pkg = await createOfferPackage(ctx.prisma, { creditAmount: 25, priceAmount: 49900 });
  return { owner, provider, pkg, cookie: await loginAs(ctx.prisma, owner.id) };
}

const ACCEPTED = { termsAccepted: true, termsVersion: TERMS.version };

function checkout(providerId: string, cookie: string, body: Record<string, unknown>) {
  return request(ctx.server)
    .post(`/providers/${providerId}/checkout-sessions`)
    .set('Cookie', cookie)
    .set('User-Agent', CANARY_UA)
    .set('x-taktic-client-channel', 'web')
    .send(body);
}

describe('gate closed (the default): the checkout is exactly what it was', () => {
  it('serves no terms at all', async () => {
    const { cookie } = await fixture();
    const response = await request(ctx.server).get('/payments/purchase-terms').set('Cookie', cookie).expect(200);
    expect(response.body).toEqual({ required: false });
  });

  it('opens a checkout with no acceptance, no evidence column and an unchanged response shape', async () => {
    const { provider, pkg, cookie } = await fixture();
    const response = await checkout(provider.id, cookie, { packageId: pkg.id }).expect(201);

    expect(Object.keys(response.body)).toEqual(['purchase', 'checkout']);
    expect(response.body.purchase).not.toHaveProperty('termsAcceptanceRequired');
    expect(response.body.purchase).not.toHaveProperty('purchaseTermsAcceptanceId');
    expect(response.body.purchase).not.toHaveProperty('paymentReference');

    const row = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: response.body.purchase.id } });
    expect(row.termsAcceptanceRequired).toBe(false);
    expect(row.purchaseTermsAcceptanceId).toBeNull();
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
  });

  it('ignores terms fields a client sends anyway, and writes nothing for them', async () => {
    const { provider, pkg, cookie } = await fixture();
    await checkout(provider.id, cookie, { packageId: pkg.id, termsAccepted: false, termsVersion: 'eski' }).expect(201);
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
  });

  it('still lets the legacy purchase route and an operator behave as before', async () => {
    const { provider, pkg } = await fixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ packageId: pkg.id })
      .expect(201);
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
  });
});

describe('gate open: every new purchase is born with its acceptance', () => {
  beforeEach(openGate);

  it('serves the draft text, labelled PENDING, and nothing about any acceptance', async () => {
    const { cookie } = await fixture();
    const { body } = await request(ctx.server).get('/payments/purchase-terms').set('Cookie', cookie).expect(200);
    expect(body).toEqual({
      required: true,
      documentKey: 'PACKAGE_PURCHASE_TERMS',
      version: TERMS.version,
      legalReviewStatus: 'PENDING',
      documents: TERMS.documents.map(({ key, title, text }) => ({ key, title, text })),
    });
  });

  it('refuses an unticked box, and writes neither purchase nor acceptance', async () => {
    const { provider, pkg, cookie } = await fixture();
    for (const body of [
      { packageId: pkg.id },
      { packageId: pkg.id, termsAccepted: false, termsVersion: TERMS.version },
    ]) {
      const response = await checkout(provider.id, cookie, body).expect(400);
      expect(response.body.code).toBe('PURCHASE_TERMS_NOT_ACCEPTED');
    }
    // A truthy string is not a ticked box.
    await checkout(provider.id, cookie, { packageId: pkg.id, termsAccepted: 'true', termsVersion: TERMS.version }).expect(400);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
    expect(adapter.opened).toBe(0);
  });

  it('refuses a stale version', async () => {
    const { provider, pkg, cookie } = await fixture();
    const response = await checkout(provider.id, cookie, { packageId: pkg.id, termsAccepted: true, termsVersion: 'eski-surum' }).expect(400);
    expect(response.body.code).toBe('PURCHASE_TERMS_VERSION_STALE');
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('writes the server’s own snapshot, its digest, the request meta and the channel', async () => {
    const { owner, provider, pkg, cookie } = await fixture();
    const before = Date.now();
    const response = await checkout(provider.id, cookie, {
      packageId: pkg.id,
      ...ACCEPTED,
      // Whatever a client says the text or the time was is not a field.
    }).expect(201);

    const purchase = await ctx.prisma.packagePurchase.findUniqueOrThrow({
      where: { id: response.body.purchase.id },
      include: { purchaseTermsAcceptance: true },
    });
    expect(purchase.termsAcceptanceRequired).toBe(true);
    const acceptance = purchase.purchaseTermsAcceptance!;
    expect(acceptance).toMatchObject({
      purchaseId: purchase.id,
      userId: owner.id,
      documentKey: 'PACKAGE_PURCHASE_TERMS',
      documentVersion: TERMS.version,
      documentSha256: TERMS.sha256,
      documentTextSnapshot: SNAPSHOT,
      userAgent: CANARY_UA,
      sourceChannel: SourceChannel.WEB,
    });
    expect(sha256Hex(acceptance.documentTextSnapshot)).toBe(acceptance.documentSha256);
    expect(acceptance.clientIp).toMatch(/127\.0\.0\.1|::1/);
    expect(acceptance.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(acceptance.acceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('records an undeclared channel as UNKNOWN', async () => {
    const { provider, pkg, cookie } = await fixture();
    const response = await request(ctx.server)
      .post(`/providers/${provider.id}/checkout-sessions`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id, ...ACCEPTED })
      .expect(201);
    const acceptance = await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({
      where: { purchaseId: response.body.purchase.id },
    });
    expect(acceptance.sourceChannel).toBe(SourceChannel.UNKNOWN);
  });

  it('never hands back a checkout opened before the gate, or under another version', async () => {
    const { provider, pkg, cookie } = await fixture();

    delete process.env.PURCHASE_TERMS_GATE;
    const ungated = await checkout(provider.id, cookie, { packageId: pkg.id }).expect(201);
    openGate();

    const gated = await checkout(provider.id, cookie, { packageId: pkg.id, ...ACCEPTED }).expect(201);
    expect(gated.body.purchase.id).not.toBe(ungated.body.purchase.id);
    expect(gated.body.checkout.reused).toBe(false);

    const again = await checkout(provider.id, cookie, { packageId: pkg.id, ...ACCEPTED }).expect(201);
    expect(again.body.purchase.id).toBe(gated.body.purchase.id);
    expect(again.body.checkout.reused).toBe(true);
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(1);
  });

  it('lets only the provider account accept, on the legacy route too', async () => {
    const { provider, pkg, cookie } = await fixture();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });

    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .send({ packageId: pkg.id, ...ACCEPTED })
      .expect(403);
    await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id })
      .expect(400);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);

    const created = await request(ctx.server)
      .post(`/providers/${provider.id}/package-purchases`)
      .set('Cookie', cookie)
      .send({ packageId: pkg.id, ...ACCEPTED })
      .expect(201);
    const row = await ctx.prisma.packagePurchase.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.termsAcceptanceRequired).toBe(true);
  });

  it('leaks no IP, user agent, digest, snapshot or acceptance id into any projection', async () => {
    const { provider, pkg, cookie } = await fixture();
    const checkoutResponse = await checkout(provider.id, cookie, { packageId: pkg.id, ...ACCEPTED }).expect(201);
    const purchaseId = checkoutResponse.body.purchase.id as string;
    const acceptance = await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({ where: { purchaseId } });

    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, admin.id);

    const bodies = [
      checkoutResponse.text,
      (await request(ctx.server).get(`/providers/${provider.id}/package-purchases`).set('Cookie', cookie).expect(200)).text,
      (await request(ctx.server).get(`/providers/${provider.id}/package-purchases/${purchaseId}`).set('Cookie', cookie).expect(200)).text,
      (await request(ctx.server).get('/package-purchases').set('Cookie', adminCookie).expect(200)).text,
      (await request(ctx.server).get(`/package-purchases/${purchaseId}`).set('Cookie', adminCookie).expect(200)).text,
      (await request(ctx.server).get('/finance/summary').set('Cookie', adminCookie).expect(200)).text,
      (await request(ctx.server).get('/payments/purchase-terms').set('Cookie', cookie).expect(200)).text,
      (await request(ctx.server).get(`/providers/${provider.id}/credits`).set('Cookie', cookie).expect(200)).text,
    ];

    const secrets = [
      acceptance.id,
      acceptance.documentSha256,
      CANARY_UA,
      'TakTicCanaryAgent',
      acceptance.clientIp!,
      'TAKTIC PACKAGE_PURCHASE_TERMS',
      'termsAcceptanceRequired',
      'purchaseTermsAcceptance',
      'documentTextSnapshot',
      'clientIp',
      'userAgent',
    ];
    for (const body of bodies) {
      for (const secret of secrets) {
        expect(body, `leaked ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe('the database holds the invariants on its own', () => {
  async function purchaseData(providerId: string, packageId: string) {
    return {
      providerId,
      packageId,
      creditAmountSnapshot: 25,
      priceAmountSnapshot: 49900,
      packageNameSnapshot: 'Paket',
    } satisfies Prisma.PackagePurchaseUncheckedCreateInput;
  }

  function acceptanceData(purchaseId: string, userId: string, overrides: Partial<Prisma.PurchaseTermsAcceptanceUncheckedCreateInput> = {}) {
    return {
      purchaseId,
      userId,
      documentKey: 'PACKAGE_PURCHASE_TERMS',
      documentVersion: TERMS.version,
      documentSha256: TERMS.sha256,
      documentTextSnapshot: SNAPSHOT,
      clientIp: '203.0.113.7',
      userAgent: CANARY_UA,
      sourceChannel: SourceChannel.WEB,
      ...overrides,
    } satisfies Prisma.PurchaseTermsAcceptanceUncheckedCreateInput;
  }

  /** The service's write order, done by hand: acceptance, then purchase, one transaction. */
  async function enforcedPurchase(
    owner: { id: string },
    providerId: string,
    packageId: string,
    acceptanceOverrides: Partial<Prisma.PurchaseTermsAcceptanceUncheckedCreateInput> = {},
  ) {
    return ctx.prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const acceptance = await tx.purchaseTermsAcceptance.create({
        data: acceptanceData(id, owner.id, acceptanceOverrides),
      });
      const purchase = await tx.packagePurchase.create({
        data: {
          id,
          ...(await purchaseData(providerId, packageId)),
          termsAcceptanceRequired: true,
          purchaseTermsAcceptanceId: acceptance.id,
        },
      });
      return { purchase, acceptance };
    });
  }

  it('an enforced purchase cannot be born without its acceptance — whatever createdAt claims', async () => {
    const { provider, pkg } = await fixture();
    for (const createdAt of [undefined, new Date('2000-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z')]) {
      await expect(
        ctx.prisma.packagePurchase.create({
          data: { ...(await purchaseData(provider.id, pkg.id)), termsAcceptanceRequired: true, createdAt },
        }),
      ).rejects.toThrow(/PackagePurchase_terms_acceptance_matches_requirement/);
    }
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('an unenforced purchase cannot carry an acceptance, and a vitrin purchase cannot be enforced', async () => {
    const { owner, provider, pkg } = await fixture();
    const { acceptance } = await enforcedPurchase(owner, provider.id, pkg.id);
    await expect(
      ctx.prisma.packagePurchase.create({
        data: { ...(await purchaseData(provider.id, pkg.id)), purchaseTermsAcceptanceId: acceptance.id },
      }),
    ).rejects.toThrow();
    // A vitrin row cannot be built here without its own terms and card
    // columns, so the offer-only rule is read from the catalogue instead.
    const check = await ctx.prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'PackagePurchase_terms_acceptance_offer_only'`;
    expect(check[0]?.def).toContain(`'${PackagePurchaseKind.OFFER_PACKAGE}'`);
  });

  it('an acceptance whose purchase never arrives fails the commit, so neither row exists', async () => {
    const { owner } = await fixture();
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.purchaseTermsAcceptance.create({ data: acceptanceData(randomUUID(), owner.id) });
      }),
    ).rejects.toThrow(/PurchaseTermsAcceptance_purchaseId_id_fkey|foreign key/i);
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
  });

  it('an acceptance cannot be attached to a purchase other than its own', async () => {
    const { owner, provider, pkg } = await fixture();
    const first = await enforcedPurchase(owner, provider.id, pkg.id);

    // A second purchase naming the first purchase's acceptance: unique, and the pair would not match.
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.packagePurchase.create({
          data: {
            ...(await purchaseData(provider.id, pkg.id)),
            termsAcceptanceRequired: true,
            purchaseTermsAcceptanceId: first.acceptance.id,
          },
        });
      }),
    ).rejects.toThrow();

    // An acceptance written for purchase X, attached to purchase Y.
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        const x = randomUUID();
        const acceptance = await tx.purchaseTermsAcceptance.create({ data: acceptanceData(x, owner.id) });
        await tx.packagePurchase.create({
          data: {
            id: randomUUID(),
            ...(await purchaseData(provider.id, pkg.id)),
            termsAcceptanceRequired: true,
            purchaseTermsAcceptanceId: acceptance.id,
          },
        });
      }),
    ).rejects.toThrow(/PurchaseTermsAcceptance_purchaseId_id_fkey|foreign key/i);

    // A second acceptance for an already-accepted purchase.
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.purchaseTermsAcceptance.create({ data: acceptanceData(first.purchase.id, owner.id) });
      }),
    ).rejects.toThrow(/purchaseId/);

    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(1);
  });

  it('the acceptance is append-only: no update of any column, no delete', async () => {
    const { owner, provider, pkg } = await fixture();
    const { acceptance, purchase } = await enforcedPurchase(owner, provider.id, pkg.id);

    for (const data of [
      { documentTextSnapshot: `${SNAPSHOT} ` },
      { sourceChannel: SourceChannel.MOBILE },
      { clientIp: null },
      { acceptedAt: new Date('2000-01-01T00:00:00Z') },
      { purchaseId: randomUUID() },
    ] satisfies Prisma.PurchaseTermsAcceptanceUncheckedUpdateInput[]) {
      await expect(
        ctx.prisma.purchaseTermsAcceptance.update({ where: { id: acceptance.id }, data }),
      ).rejects.toThrow(/append-only/);
    }
    await expect(ctx.prisma.purchaseTermsAcceptance.delete({ where: { id: acceptance.id } })).rejects.toThrow(
      /append-only|foreign key|violates/i,
    );
    await expect(
      ctx.prisma.$executeRaw`DELETE FROM "PurchaseTermsAcceptance" WHERE "id" = ${acceptance.id}`,
    ).rejects.toThrow();

    expect(await ctx.prisma.purchaseTermsAcceptance.findUniqueOrThrow({ where: { id: acceptance.id } })).toEqual(
      acceptance,
    );
    expect(purchase.purchaseTermsAcceptanceId).toBe(acceptance.id);
  });

  it('the purchase’s requirement and link cannot change after the insert', async () => {
    const { owner, provider, pkg } = await fixture();
    const { purchase } = await enforcedPurchase(owner, provider.id, pkg.id);
    const other = await enforcedPurchase(owner, provider.id, pkg.id);

    for (const data of [
      { termsAcceptanceRequired: false, purchaseTermsAcceptanceId: null },
      { purchaseTermsAcceptanceId: other.acceptance.id },
    ]) {
      await expect(ctx.prisma.packagePurchase.update({ where: { id: purchase.id }, data })).rejects.toThrow(
        /immutable|violates|constraint/i,
      );
    }

    // Unenforced stays unenforced: an old purchase cannot be retro-labelled either.
    const legacy = await ctx.prisma.packagePurchase.create({ data: await purchaseData(provider.id, pkg.id) });
    await expect(
      ctx.prisma.packagePurchase.update({ where: { id: legacy.id }, data: { termsAcceptanceRequired: true } }),
    ).rejects.toThrow(/immutable/);

    // Every other column keeps its writers.
    await ctx.prisma.packagePurchase.update({
      where: { id: purchase.id },
      data: { status: PackagePurchaseStatus.PAID, paidAt: new Date() },
    });
  });

  it('acceptedAt is the transaction clock, never the caller’s', async () => {
    const { owner, provider, pkg } = await fixture();
    const { acceptance } = await enforcedPurchase(owner, provider.id, pkg.id, {
      acceptedAt: new Date('2000-01-01T00:00:00Z'),
    });
    expect(Math.abs(acceptance.acceptedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('the digest is bound to the stored text; the text is the full, versioned three-part snapshot', async () => {
    const { owner, provider, pkg } = await fixture();
    const tampered = `${SNAPSHOT}\nEk madde.`;
    const linkOnly = `TAKTIC PACKAGE_PURCHASE_TERMS\nversion: ${TERMS.version}\nhttps://taktic.example/sozlesmeler`;
    const otherVersion = SNAPSHOT.replace(`version: ${TERMS.version}`, 'version: 1999-01-01.eski');

    const cases: [Partial<Prisma.PurchaseTermsAcceptanceUncheckedCreateInput>, RegExp][] = [
      [{ documentTextSnapshot: tampered }, /sha256_matches_snapshot/],
      [{ documentSha256: 'A'.repeat(64) }, /sha256_format/],
      [{ documentTextSnapshot: linkOnly, documentSha256: sha256Hex(linkOnly) }, /snapshot_shape/],
      [{ documentTextSnapshot: otherVersion, documentSha256: sha256Hex(otherVersion) }, /snapshot_shape/],
      [{ documentKey: 'SOMETHING_ELSE' }, /document_key/],
      [{ documentVersion: '' }, /document_version/],
      [{ userAgent: 'x'.repeat(501) }, /user_agent_length/],
    ];
    for (const [overrides, pattern] of cases) {
      await expect(enforcedPurchase(owner, provider.id, pkg.id, overrides)).rejects.toThrow(pattern);
    }
    expect(await ctx.prisma.purchaseTermsAcceptance.count()).toBe(0);
    expect(await ctx.prisma.packagePurchase.count()).toBe(0);
  });

  it('a purchase from before the gate keeps an honest NULL and reads normally everywhere', async () => {
    const { provider, pkg, cookie } = await fixture();
    const legacy = await ctx.prisma.packagePurchase.create({
      data: { ...(await purchaseData(provider.id, pkg.id)), createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    expect(legacy.termsAcceptanceRequired).toBe(false);
    expect(legacy.purchaseTermsAcceptanceId).toBeNull();

    openGate();
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    await request(ctx.server).get(`/providers/${provider.id}/package-purchases/${legacy.id}`).set('Cookie', cookie).expect(200);
    await request(ctx.server)
      .get(`/package-purchases/${legacy.id}`)
      .set('Cookie', await loginAs(ctx.prisma, admin.id))
      .expect(200);
  });
});

describe('boot', () => {
  it('a process asked to open the gate with a malformed value does not start', async () => {
    process.env.PURCHASE_TERMS_GATE = 'evet';
    await expect(createTestApp()).rejects.toThrow(/PURCHASE_TERMS_GATE must be "on" or "off"/);
  });
});
