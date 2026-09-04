import request from 'supertest';
import { UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCategory,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  serviceRequestPayload,
  type TestContext,
} from './harness';

/**
 * Where a request's contact details come from.
 *
 * Two sources, and the session decides between them — never the body. A
 * signed-in customer's request carries their account's name, telephone number
 * and e-mail address, read from the User row at creation time; a request that
 * names a different contact person carries that person's, and stays owned by
 * the account all the same. A visitor with no session is untouched by any of
 * it: their own details are the request's, exactly as before.
 *
 * The forgery case is the point of the whole arrangement. A client that posts a
 * plausible-looking default contact alongside a customer session must not be
 * able to decide what is stored against that customer's request.
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

/** The contact triple a request was actually stored with, plus its owner. */
async function storedContact(id: string) {
  return ctx.prisma.serviceRequest.findUniqueOrThrow({
    where: { id },
    select: {
      customerId: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
    },
  });
}

describe('service request contact details', () => {
  it('stores the signed-in customer account contact, not the body', async () => {
    const category = await createCategory(ctx.prisma, 'Hesap iletişimi', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Ayşe Yılmaz',
      phone: '05551110001',
      email: 'ayse@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      // Deliberately a complete, well-formed contact — the kind a form would
      // post. Every field of it has to be discarded.
      .send(
        serviceRequestPayload(category.slug, {
          customerName: 'Sahte İsim',
          customerPhone: '05559998877',
          customerEmail: 'sahte@example.test',
        }),
      )
      .expect(201);

    expect(await storedContact(response.body.id)).toEqual({
      customerId: customer.id,
      customerName: 'Ayşe Yılmaz',
      customerPhone: '05551110001',
      customerEmail: 'ayse@example.test',
    });
  });

  it('derives the account contact when the body carries none at all', async () => {
    const category = await createCategory(ctx.prisma, 'Alansız gövde', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Mehmet Demir',
      phone: '05551110002',
      email: 'mehmet@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      // What the form posts on the default path: no contact keys whatsoever.
      // JSON.stringify drops an undefined value, so this is a payload with
      // three fewer keys rather than three empty ones.
      .send(
        serviceRequestPayload(category.slug, {
          customerName: undefined,
          customerPhone: undefined,
          customerEmail: undefined,
        }),
      )
      .expect(201);

    expect(await storedContact(response.body.id)).toEqual({
      customerId: customer.id,
      customerName: 'Mehmet Demir',
      customerPhone: '05551110002',
      customerEmail: 'mehmet@example.test',
    });
  });

  it('stores the alternate contact while the request stays with the account', async () => {
    const category = await createCategory(ctx.prisma, 'Farklı kişi', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Zeynep Kaya',
      phone: '05551110003',
      email: 'zeynep@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Ali Vekil',
          customerPhone: '0555 111 00 04',
          customerEmail: 'Ali.Vekil@Example.Test',
        }),
      )
      .expect(201);

    expect(await storedContact(response.body.id)).toEqual({
      // Ownership is not what the contact fields decide. The request belongs to
      // the account that created it, and the alternate person never becomes a
      // customer of the platform.
      customerId: customer.id,
      customerName: 'Ali Vekil',
      // Normalised the same way a guest's would be: punctuation out of the
      // number, the address folded to lower case.
      customerPhone: '05551110004',
      customerEmail: 'ali.vekil@example.test',
    });

    // The account itself is untouched by naming somebody else.
    const account = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: customer.id },
      select: { name: true, phone: true, email: true, role: true },
    });
    expect(account).toEqual({
      name: 'Zeynep Kaya',
      phone: '05551110003',
      email: 'zeynep@example.test',
      role: UserRole.CUSTOMER,
    });
  });

  it('refuses an alternate contact with a field missing', async () => {
    const category = await createCategory(ctx.prisma, 'Eksik vekil', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05551110005',
      email: 'eksik-vekil@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerPhone: undefined,
        }),
      )
      .expect(400);

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses an alternate contact whose e-mail is not an address', async () => {
    const category = await createCategory(ctx.prisma, 'Geçersiz vekil', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05551110006',
      email: 'gecersiz-vekil@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerEmail: 'not-an-address',
        }),
      )
      .expect(400);

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('refuses the default path when the account contact is incomplete', async () => {
    const category = await createCategory(ctx.prisma, 'Eksik hesap', { offerCreditCost: 1 });
    // An account with no telephone number: every one of the three columns is
    // nullable, and an older customer may never have been asked for one.
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: 'Telefonsuz Müşteri',
      phone: null,
      email: 'telefonsuz@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(serviceRequestPayload(category.slug))
      .expect(400);

    expect(response.body.code).toBe('ACCOUNT_CONTACT_INCOMPLETE');
    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });

  it('lets an incomplete account create a request by naming a contact person', async () => {
    const category = await createCategory(ctx.prisma, 'Eksik hesap vekili', { offerCreditCost: 1 });
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      name: null,
      phone: null,
      email: 'isimsiz@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Vekil Kişi',
          customerPhone: '05551110007',
          customerEmail: 'vekil@example.test',
        }),
      )
      .expect(201);

    expect(await storedContact(response.body.id)).toEqual({
      customerId: customer.id,
      customerName: 'Vekil Kişi',
      customerPhone: '05551110007',
      customerEmail: 'vekil@example.test',
    });
  });

  it('leaves the guest flow exactly as it was', async () => {
    const category = await createCategory(ctx.prisma, 'Misafir', { offerCreditCost: 1 });

    const response = await request(ctx.server)
      .post('/service-requests')
      .send(
        serviceRequestPayload(category.slug, {
          customerName: 'Misafir Müşteri',
          customerPhone: '05551110008',
          customerEmail: 'misafir@example.test',
        }),
      )
      .expect(201);

    const stored = await storedContact(response.body.id);
    expect(stored.customerName).toBe('Misafir Müşteri');
    expect(stored.customerPhone).toBe('05551110008');
    expect(stored.customerEmail).toBe('misafir@example.test');

    // The password-less account a guest request creates behind the scenes, as
    // ever — and it is the contact the guest gave that identifies it.
    const owner = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: stored.customerId as string },
      select: { email: true, phone: true, role: true },
    });
    expect(owner).toEqual({
      email: 'misafir@example.test',
      phone: '05551110008',
      role: UserRole.CUSTOMER,
    });
  });

  it('still requires a guest to give all three details', async () => {
    const category = await createCategory(ctx.prisma, 'Eksik misafir', { offerCreditCost: 1 });

    const payload = serviceRequestPayload(category.slug, { customerEmail: undefined });

    await request(ctx.server).post('/service-requests').send(payload).expect(400);

    // A guest cannot buy the account path by claiming it: the flag has nothing
    // to switch to, and the three fields are still theirs to give.
    await request(ctx.server)
      .post('/service-requests')
      .send({ ...payload, useAlternateContact: false })
      .expect(400);

    expect(await ctx.prisma.serviceRequest.count()).toBe(0);
  });
});
