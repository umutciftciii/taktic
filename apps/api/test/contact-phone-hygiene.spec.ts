import { ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY } from '../src/modules/service-requests/service-requests.constants';
import {
  ACCEPT_OFFER,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  providerPayload,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * CONTACT-PHONE-DATA-HYGIENE-001: the two contact-number columns that are not
 * an identity.
 *
 * `ProviderProfile.phone` is current profile data — every write path stores it
 * in E.164 from now on. `ServiceRequest.customerPhone` is a snapshot written
 * once at creation: new requests store E.164, and requests from before keep
 * the digits-only spelling they were written with. These cases hold both
 * halves: the new writes, and the old rows still working wherever they are
 * read.
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
  ctx.sms.clear();
});

afterEach(() => {
  delete process.env.CONTACT_SHARING_ENABLED;
});

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

async function providerAccount(phone?: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER, ...(phone ? { phone } : {}) });
  return { user, cookie: await loginAs(ctx.prisma, user.id) };
}

describe('ProviderProfile.phone — every write is canonical', () => {
  it('stores a new application’s number in E.164, whatever spelling was typed', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const { cookie } = await providerAccount();

    const created = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), phone: '0 (555) 123 45 67' })
      .expect(201);

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.phone).toBe('+905551234567');
  });

  it('stores an edit — the owner’s or an operator’s — in E.164', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const { cookie } = await providerAccount();
    const created = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send(providerPayload([category.id]))
      .expect(201);

    await request(ctx.server)
      .patch(`/providers/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), phone: '5551112233' })
      .expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: created.body.id } })).phone).toBe(
      '+905551112233',
    );

    await request(ctx.server)
      .patch(`/providers/${created.body.id}`)
      .set('Cookie', await adminCookie())
      .send({ ...providerPayload([category.id]), phone: '00905551112244' })
      .expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: created.body.id } })).phone).toBe(
      '+905551112244',
    );
  });

  it('refuses a number the canonicaliser cannot read, and writes nothing', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const { cookie } = await providerAccount();

    const response = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), phone: '12345' })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('Telefon numarası geçerli görünmüyor');
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('keeps the column required: an empty or missing number is refused as before', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const { cookie } = await providerAccount();
    const { phone: _phone, ...withoutPhone } = providerPayload([category.id]);

    await request(ctx.server).post('/providers').set('Cookie', cookie).send(withoutPhone).expect(400);
    await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({ ...withoutPhone, phone: '   ' })
      .expect(400);
    expect(await ctx.prisma.providerProfile.count()).toBe(0);
  });

  it('a business number typed as the owner’s own is stored equal to User.phone', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const { user, cookie } = await providerAccount('+905556667788');

    const created = await request(ctx.server)
      .post('/providers')
      .set('Cookie', cookie)
      .send({ ...providerPayload([category.id]), phone: '0555 666 77 88' })
      .expect(201);

    const stored = await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: created.body.id } });
    const owner = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.phone).toBe(owner.phone);
    // The profile write never reaches the account: no identity rule rides on it.
    expect(owner.phone).toBe('+905556667788');
  });

  it('allows two profiles to carry the same business number — it is not an identity', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const first = await providerAccount();
    const second = await providerAccount();

    for (const { cookie } of [first, second]) {
      await request(ctx.server)
        .post('/providers')
        .set('Cookie', cookie)
        .send({ ...providerPayload([category.id]), phone: '05554443322' })
        .expect(201);
    }

    expect(await ctx.prisma.providerProfile.count({ where: { phone: '+905554443322' } })).toBe(2);
  });
});

describe('ServiceRequest.customerPhone — new snapshots are canonical', () => {
  it('a guest request stores E.164, the same number as the account it opens', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(serviceRequestPayload(category.slug, { customerPhone: '0555 222 33 44', customerEmail: 'guest@example.test' }))
      .expect(201);

    const stored = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: response.body.id },
      include: { customer: { select: { phone: true } } },
    });
    expect(stored.customerPhone).toBe('+905552223344');
    expect(stored.customer?.phone).toBe(stored.customerPhone);
  });

  it('a signed-in customer’s default contact is the account’s canonical number', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905552223355' });

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send(serviceRequestPayload(category.slug, { customerName: undefined, customerPhone: undefined, customerEmail: undefined }))
      .expect(201);

    expect(response.body.customerPhone).toBe('+905552223355');
  });

  it('an alternate contact is stored in E.164 and stays off every account', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905552223366' });

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu',
          customerPhone: '90 555 222 33 77',
          customerEmail: 'komsu@example.test',
        }),
      )
      .expect(201);

    expect(response.body.customerPhone).toBe('+905552223377');
    expect(response.body.customerId).toBe(customer.id);
    expect(await ctx.prisma.user.findFirst({ where: { phone: '+905552223377' } })).toBeNull();
  });

  it('refuses an alternate contact number nobody could text, rather than storing it', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu',
          customerPhone: '12345',
          customerEmail: 'komsu@example.test',
        }),
      )
      .expect(400);

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('counts a number’s digits-only past requests toward its 24h budget', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    // Five requests from before canonical storage, all inside the window.
    for (let index = 0; index < SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY; index += 1) {
      await ctx.prisma.serviceRequest.create({
        data: {
          categoryId: category.id,
          requestNumber: `TR-LEGACY-${index}`,
          customerName: 'Eski Talep',
          customerPhone: index % 2 === 0 ? '05552220099' : '5552220099',
          customerEmail: `legacy-${index}@example.test`,
          city: 'İstanbul',
          district: 'Kadıköy',
          status: ServiceRequestStatus.SUBMITTED,
          qualityScore: 80,
        },
      });
    }
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu',
          customerPhone: '+90 555 222 00 99',
          customerEmail: 'komsu@example.test',
        }),
      );

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('REQUEST_RATE_LIMITED');
  });
});

describe('ServiceRequest.customerPhone — historical snapshots are left as written', () => {
  async function matchedPair(customerPhone: string | undefined) {
    process.env.CONTACT_SHARING_ENABLED = 'true';
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    let requestId: string;
    if (customerPhone === undefined) {
      // A new request, through the API: canonical snapshot.
      const created = await request(ctx.server)
        .post('/service-requests')
        .set('Cookie', customerCookie)
        .send(
          serviceRequestPayload(category.slug, {
            useAlternateContact: true,
            customerName: 'Yeni Talep',
            customerPhone: '0555 999 88 11',
            customerEmail: 'yeni@example.test',
          }),
        )
        .expect(201);
      requestId = created.body.id;
      await ctx.prisma.serviceRequest.update({
        where: { id: requestId },
        data: { status: ServiceRequestStatus.APPROVED, approvedAt: new Date() },
      });
    } else {
      requestId = (await createApprovedRequest(ctx.prisma, { categoryId: category.id, customerId: customer.id, customerPhone })).id;
    }
    await ctx.prisma.serviceRequest.update({
      where: { id: requestId },
      data: { contactDisclosureVersion: 'built-in-v1', contactDisclosureAcceptedAt: new Date() },
    });

    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createDiscoverableProvider(ctx.prisma, { userId: ownerUser.id, categoryId: category.id });
    const providerCookie = await loginAs(ctx.prisma, ownerUser.id);
    await grantCredits(ctx.prisma, provider.id, 5);
    const offer = await request(ctx.server)
      .post(`/providers/${provider.id}/requests/${requestId}/offers`)
      .set('Cookie', providerCookie)
      .send(offerPayload())
      .expect(201);
    await request(ctx.server)
      .post(`/service-requests/${requestId}/offers/${offer.body.id}/action`)
      .set('Cookie', customerCookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    return { requestId, provider, providerCookie, offerId: offer.body.id as string };
  }

  it('reveals a pre-change request’s number exactly as it was stored', async () => {
    const { requestId, provider, providerCookie, offerId } = await matchedPair('05559998822');

    const reveal = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}/matched-contact`)
      .set('Cookie', providerCookie)
      .expect(200);

    expect(reveal.body.customer.customerPhone).toBe('05559998822');
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).customerPhone).toBe(
      '05559998822',
    );
  });

  it('reveals a new request’s number in E.164', async () => {
    const { provider, providerCookie, offerId } = await matchedPair(undefined);

    const reveal = await request(ctx.server)
      .get(`/providers/${provider.id}/offers/${offerId}/matched-contact`)
      .set('Cookie', providerCookie)
      .expect(200);

    expect(reveal.body.customer.customerPhone).toBe('+905559998811');
  });

  it('texts a pre-change request’s code to the canonical number, without rewriting the row', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const legacy = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
      customerPhone: '5559998833',
    });

    const sent = await request(ctx.server)
      .post(`/service-requests/${legacy.id}/phone-verification`)
      .set('Cookie', await loginAs(ctx.prisma, customer.id))
      .expect(201);

    expect(ctx.sms.sent.at(-1)?.to).toBe('+905559998833');
    expect(sent.body.maskedPhone).toBeTruthy();
    expect((await ctx.prisma.serviceRequest.findUniqueOrThrow({ where: { id: legacy.id } })).customerPhone).toBe(
      '5559998833',
    );
  });

  it('texts a new request’s code to the number it stored', async () => {
    const category = await createCategory(ctx.prisma, 'Klima');
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const created = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu',
          customerPhone: '0555 999 88 44',
          customerEmail: 'komsu@example.test',
        }),
      )
      .expect(201);

    await request(ctx.server).post(`/service-requests/${created.body.id}/phone-verification`).set('Cookie', cookie).expect(201);

    expect(ctx.sms.sent.at(-1)?.to).toBe('+905559998844');
    expect(created.body.customerPhone).toBe('+905559998844');
  });

  it('leaves a pre-change provider profile readable and editable', async () => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const category = await createCategory(ctx.prisma, 'Klima');
    const legacy = await createProviderProfile(ctx.prisma, { userId: owner.id });
    expect(legacy.phone).toMatch(/^0555/);

    const read = await request(ctx.server)
      .get(`/providers/${legacy.id}`)
      .set('Cookie', await loginAs(ctx.prisma, owner.id))
      .expect(200);
    expect(read.body.phone).toBe(legacy.phone);

    // The next save rewrites it the one way every save does.
    await request(ctx.server)
      .patch(`/providers/${legacy.id}`)
      .set('Cookie', await loginAs(ctx.prisma, owner.id))
      .send({ ...providerPayload([category.id]), email: legacy.email, phone: legacy.phone })
      .expect(200);
    expect((await ctx.prisma.providerProfile.findUniqueOrThrow({ where: { id: legacy.id } })).phone).toBe(
      `+90${legacy.phone.slice(1)}`,
    );
  });
});
