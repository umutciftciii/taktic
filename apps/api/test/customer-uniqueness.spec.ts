import { CustomerOrigin, ServiceCategoryKind, UserRole } from '@prisma/client';
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
  loginAs,
  proveShowcaseLeadPhone,
  resetAuthThrottle,
  resetDatabase,
  serviceRequestPayload,
  showcaseLeadPayload,
  type TestContext,
} from './harness';

/**
 * AUTH-REG-001 — one telephone number, one e-mail address, one account.
 *
 * The rule is global: it does not care which door the second account tries to
 * come in through (self-registration, a guest request, a vitrin lead, the
 * admin's user screen) nor which kind of account already holds the number. The
 * stored form is what makes the rule enforceable — `User.phone` is E.164 and
 * `User.email` is trimmed and lower-cased — so a spelling difference can never
 * buy a second row, and a lost race is refused by the unique index rather than
 * by a pre-read that both sides passed.
 *
 * A refusal says that the contact details match an account and stops there. It
 * never says whether the number or the address collided, and it never reuses,
 * merges or re-parents anything: the request that lost is simply not written.
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
  ctx.notifications.clear();
  // Several cases post more than five guest requests, and the registration
  // endpoint has its own budget; both share one storage.
  resetAuthThrottle(ctx.app);
});

const CONFLICT_CODE = 'CUSTOMER_IDENTITY_CONFLICT';
const CONFLICT_MESSAGE =
  'Bu telefon numarası veya e-posta adresi kayıtlı bir hesapla eşleşiyor. Giriş yapın ya da daha önce talep oluşturduysanız hesabınızı etkinleştirin.';

const CANONICAL = '+905321234567';
/** Every spelling a person produces for the number above. */
const SPELLINGS = [
  '05321234567',
  '0532 123 45 67',
  '0532-123-45-67',
  '+90 532 123 45 67',
  '905321234567',
  '5321234567',
];

/** Everything a refused creation must leave untouched. */
async function snapshot() {
  const [users, requests, leads, verifications, drafts, logs, activations, sessions, emailTokens] =
    await Promise.all([
      ctx.prisma.user.count(),
      ctx.prisma.serviceRequest.count(),
      ctx.prisma.showcaseLead.count(),
      ctx.prisma.phoneVerification.count(),
      ctx.prisma.requestDraft.count(),
      ctx.prisma.notificationLog.count(),
      ctx.prisma.customerActivationToken.count(),
      ctx.prisma.session.count(),
      ctx.prisma.emailVerificationToken.count(),
    ]);

  return {
    users,
    requests,
    leads,
    verifications,
    drafts,
    logs,
    activations,
    sessions,
    emailTokens,
    mails: ctx.notifications.sent.length,
  };
}

function registerCustomer(body: Record<string, unknown>) {
  return request(ctx.server).post('/auth/register-customer').send({
    name: 'Ayşe Yılmaz',
    password: 'GucluSifre123!',
    ...body,
  });
}

function registerProvider(body: Record<string, unknown>) {
  return request(ctx.server).post('/auth/register-provider').send({
    name: 'Usta Mehmet',
    password: 'GucluSifre123!',
    ...body,
  });
}

function expectIdentityConflict(response: request.Response) {
  expect(response.status).toBe(409);
  expect(response.body.code).toBe(CONFLICT_CODE);
  expect(response.body.message).toBe(CONFLICT_MESSAGE);
  expect(response.headers['set-cookie']).toBeUndefined();
}

describe('POST /auth/register-customer', () => {
  it('stores the telephone number in E.164 whatever spelling was typed', async () => {
    for (const [index, spelling] of SPELLINGS.entries()) {
      await resetDatabase(ctx.prisma);
      resetAuthThrottle(ctx.app);
      const response = await registerCustomer({
        email: `spelling-${index}@example.test`,
        phone: spelling,
      });

      expect(response.status, spelling).toBe(201);
      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(stored.phone, spelling).toBe(CANONICAL);
    }
  });

  it('refuses a second account under the same address in another case or with padding', async () => {
    expect((await registerCustomer({ email: 'ayse@example.test', phone: null })).status).toBe(201);
    const before = await snapshot();

    for (const email of ['Ayse@Example.test', '  ayse@example.test  ', 'AYSE@EXAMPLE.TEST']) {
      const response = await registerCustomer({ email, phone: null });
      expectIdentityConflict(response);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('refuses a second account under every spelling of a number already on file', async () => {
    expect((await registerCustomer({ email: 'first@example.test', phone: CANONICAL })).status).toBe(201);
    const before = await snapshot();

    for (const [index, spelling] of SPELLINGS.entries()) {
      // The spellings outnumber the endpoint's per-client budget.
      resetAuthThrottle(ctx.app);
      const response = await registerCustomer({
        email: `second-${index}@example.test`,
        phone: spelling,
      });
      expectIdentityConflict(response);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('refuses a number that an older row stores in its national spelling', async () => {
    // Rows written before canonicalisation carry whatever the visitor typed.
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05321234567' });
    const before = await snapshot();

    expectIdentityConflict(
      await registerCustomer({ email: 'later@example.test', phone: '+90 532 123 45 67' }),
    );
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a number held by any kind of account, with one sentence for all of them', async () => {
    await createUser(ctx.prisma, { role: UserRole.PROVIDER, phone: CANONICAL, email: 'prov@example.test' });
    await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: '+905329998877', email: 'adm@example.test' });
    const before = await snapshot();

    const againstProvider = await registerCustomer({ email: 'c1@example.test', phone: '0532 123 45 67' });
    const againstAdmin = await registerCustomer({ email: 'c2@example.test', phone: '0532 999 88 77' });
    expectIdentityConflict(againstProvider);
    expectIdentityConflict(againstAdmin);
    expect(againstProvider.body).toEqual(againstAdmin.body);

    expect(await snapshot()).toEqual(before);
  });

  it('gives a phone collision and an e-mail collision the same body, so the field is never named', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: CANONICAL, email: 'taken@example.test' });

    const byPhone = await registerCustomer({ email: 'free@example.test', phone: '05321234567' });
    const byEmail = await registerCustomer({ email: 'taken@example.test', phone: '05320000000' });

    expectIdentityConflict(byPhone);
    expectIdentityConflict(byEmail);
    expect(byPhone.body).toEqual(byEmail.body);
  });

  it('keeps the provider registration under the same rule', async () => {
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: CANONICAL, email: 'cust@example.test' });
    const before = await snapshot();

    expectIdentityConflict(await registerProvider({ email: 'usta@example.test', phone: '0532 123 45 67' }));
    expect(await snapshot()).toEqual(before);

    const accepted = await registerProvider({ email: 'usta@example.test', phone: '0532 765 43 21' });
    expect(accepted.status).toBe(201);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: accepted.body.id } });
    expect(stored.phone).toBe('+905327654321');
  });

  it('sends the activation for a claimable account matched by phone to the address on file, never to the one typed', async () => {
    const claimable = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05321234567',
      email: 'on-file@example.test',
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });

    const response = await registerCustomer({
      email: 'typed-by-visitor@example.test',
      phone: '+90 532 123 45 67',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ACTIVATION_REQUIRED');
    expect(response.headers['set-cookie']).toBeUndefined();

    const mail = ctx.notifications.lastOfTemplate('customer-activation');
    expect(mail?.to).toBe('on-file@example.test');
    expect(ctx.notifications.sent.map((message) => message.to)).not.toContain('typed-by-visitor@example.test');

    // Nothing was opened or changed for the typed address.
    expect(await ctx.prisma.user.count()).toBe(1);
    const unchanged = await ctx.prisma.user.findUniqueOrThrow({ where: { id: claimable.id } });
    expect(unchanged.passwordHash).toBeNull();
    expect(unchanged.email).toBe('on-file@example.test');
    expect(await ctx.prisma.customerActivationToken.count({ where: { customerId: claimable.id, usedAt: null } })).toBe(1);
  });

  it('does not activate anything when the number and the address point at two different accounts', async () => {
    await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: '05321234567',
      email: 'claimable@example.test',
      password: null,
      customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
    });
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05320000000', email: 'active@example.test' });
    const before = await snapshot();

    expectIdentityConflict(await registerCustomer({ email: 'active@example.test', phone: CANONICAL }));
    expect(await snapshot()).toEqual(before);
  });

  it('lets exactly one of two simultaneous registrations through', async () => {
    const [first, second] = await Promise.all([
      registerCustomer({ email: 'race-a@example.test', phone: '0532 123 45 67' }),
      registerCustomer({ email: 'race-b@example.test', phone: '+905321234567' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body.code).toBe(CONFLICT_CODE);

    expect(await ctx.prisma.user.count()).toBe(1);
    expect(await ctx.prisma.session.count()).toBe(1);
  });
});

describe('POST /service-requests as a guest', () => {
  async function guestRequest(categorySlug: string, overrides: Record<string, unknown>) {
    return request(ctx.server).post('/service-requests').send(serviceRequestPayload(categorySlug, overrides));
  }

  it('auto-creates the customer with the number in E.164', async () => {
    const category = await createCategory(ctx.prisma);

    const response = await guestRequest(category.slug, {
      customerPhone: '0532 123 45 67',
      customerEmail: ' Guest@Example.test ',
    });

    expect(response.status).toBe(201);
    const customer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: response.body.customerId } });
    expect(customer.phone).toBe(CANONICAL);
    expect(customer.email).toBe('guest@example.test');
    expect(customer.customerOrigin).toBe(CustomerOrigin.AUTO_CREATED_REQUEST);
  });

  it('refuses a second guest request under the same contact, writing nothing', async () => {
    const category = await createCategory(ctx.prisma);
    expect(
      (await guestRequest(category.slug, { customerPhone: '05321234567', customerEmail: 'guest@example.test' })).status,
    ).toBe(201);
    const before = await snapshot();

    for (const [index, spelling] of SPELLINGS.entries()) {
      resetAuthThrottle(ctx.app);
      const response = await guestRequest(category.slug, {
        customerPhone: spelling,
        customerEmail: index % 2 === 0 ? 'GUEST@example.test' : `other-${index}@example.test`,
      });
      expectIdentityConflict(response);
    }
    // The address alone is enough, with a number nobody has.
    expectIdentityConflict(
      await guestRequest(category.slug, { customerPhone: '05329990000', customerEmail: ' guest@example.test' }),
    );

    expect(await snapshot()).toEqual(before);
  });

  it('never hangs a guest request on an account that already exists', async () => {
    const category = await createCategory(ctx.prisma);
    const registered = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: CANONICAL,
      email: 'registered@example.test',
      customerOrigin: CustomerOrigin.REGISTERED,
    });
    const before = await snapshot();

    expectIdentityConflict(
      await guestRequest(category.slug, { customerPhone: '0532 123 45 67', customerEmail: 'fresh@example.test' }),
    );
    expectIdentityConflict(
      await guestRequest(category.slug, { customerPhone: '05320000001', customerEmail: 'registered@example.test' }),
    );

    expect(await snapshot()).toEqual(before);
    expect(await ctx.prisma.serviceRequest.count({ where: { customerId: registered.id } })).toBe(0);
  });

  it('lets exactly one of two simultaneous guest requests through, with one customer and one request', async () => {
    const category = await createCategory(ctx.prisma);

    const [first, second] = await Promise.all([
      guestRequest(category.slug, { customerPhone: '0532 123 45 67', customerEmail: 'race@example.test' }),
      guestRequest(category.slug, { customerPhone: '+905321234567', customerEmail: 'RACE@example.test' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body.code).toBe(CONFLICT_CODE);

    expect(await ctx.prisma.user.count()).toBe(1);
    expect(await ctx.prisma.serviceRequest.count()).toBe(1);
  });
});

describe('a signed-in customer naming a different contact person', () => {
  it('creates no account and keeps the request on the signed-in customer', async () => {
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905320000002' });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const usersBefore = await ctx.prisma.user.count();

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu Fatma',
          customerPhone: '0532 123 45 67',
          customerEmail: 'fatma@example.test',
        }),
      );

    expect(response.status).toBe(201);
    expect(response.body.customerId).toBe(customer.id);
    expect(response.body.customerPhone).toBe('05321234567');
    expect(await ctx.prisma.user.count()).toBe(usersBefore);
    expect(await ctx.prisma.user.findFirst({ where: { email: 'fatma@example.test' } })).toBeNull();
  });

  it('does not re-parent the request when the contact person is another customer', async () => {
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905320000002' });
    const neighbour = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      phone: CANONICAL,
      email: 'neighbour@example.test',
    });
    const cookie = await loginAs(ctx.prisma, customer.id);
    const usersBefore = await ctx.prisma.user.count();

    const response = await request(ctx.server)
      .post('/service-requests')
      .set('Cookie', cookie)
      .send(
        serviceRequestPayload(category.slug, {
          useAlternateContact: true,
          customerName: 'Komşu',
          customerPhone: '05321234567',
          customerEmail: 'neighbour@example.test',
        }),
      );

    expect(response.status).toBe(201);
    expect(response.body.customerId).toBe(customer.id);
    expect(await ctx.prisma.user.count()).toBe(usersBefore);
    expect(await ctx.prisma.serviceRequest.count({ where: { customerId: neighbour.id } })).toBe(0);
  });
});

describe('POST /showcase/cards/:id/leads as a guest', () => {
  async function publishedCard(title: string) {
    const category = await createCategory(ctx.prisma, 'Klima', {
      kind: ServiceCategoryKind.LEAF,
      offerCreditCost: 2,
    });
    const ownerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const owner = await createDiscoverableProvider(ctx.prisma, {
      userId: ownerUser.id,
      categoryId: category.id,
      areas: [{ city: 'İstanbul', district: null }],
    });
    const cards: { id: string }[] = [];
    for (const cardTitle of [title, `${title} 2`]) {
      const { card, version } = await createApprovedShowcaseCard(ctx.prisma, {
        providerId: owner.id,
        categoryId: category.id,
        title: cardTitle,
      });
      const pkg = await createShowcasePackage(ctx.prisma);
      await createLiveShowcasePlacement(ctx, {
        providerId: owner.id,
        cardId: card.id,
        versionId: version.id,
        packageId: pkg.id,
      });
      cards.push(card);
    }

    return { category, firstCard: cards[0]!, secondCard: cards[1]! };
  }

  async function openLead(cardId: string, categorySlug: string, overrides: Record<string, unknown>) {
    const payload = showcaseLeadPayload(categorySlug, overrides);
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    return request(ctx.server).post(`/showcase/cards/${cardId}/leads`).send(payload);
  }

  it('auto-creates the customer with the number in E.164', async () => {
    const { category, firstCard } = await publishedCard('Klima bakımı');

    const response = await openLead(firstCard.id, category.slug, {
      customerPhone: '0532 123 45 67',
      customerEmail: 'lead@example.test',
    });

    expect(response.status).toBe(201);
    const stored = await ctx.prisma.serviceRequest.findFirstOrThrow({ include: { customer: true } });
    expect(stored.customer?.phone).toBe(CANONICAL);
    expect(stored.customer?.customerOrigin).toBe(CustomerOrigin.AUTO_CREATED_REQUEST);
  });

  it('refuses a second guest lead under the same contact without writing a lead, a request or a proof', async () => {
    const { category, firstCard, secondCard } = await publishedCard('Klima bakımı');
    expect(
      (await openLead(firstCard.id, category.slug, { customerPhone: '05321234567', customerEmail: 'lead@example.test' }))
        .status,
    ).toBe(201);

    // The second attempt's own proof, then the snapshot: what the refused
    // submission must not add to.
    const payload = showcaseLeadPayload(category.slug, {
      customerPhone: '+90 532 123 45 67',
      customerEmail: 'someone-else@example.test',
    });
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    const before = await snapshot();

    const response = await request(ctx.server).post(`/showcase/cards/${secondCard.id}/leads`).send(payload);

    expectIdentityConflict(response);
    expect(await snapshot()).toEqual(before);
    const proof = await ctx.prisma.phoneVerification.findFirstOrThrow({
      where: { normalizedPhone: CANONICAL, requestId: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(proof.requestId).toBeNull();
  });

  it('refuses the lead when only the address belongs to an existing account', async () => {
    const { category, firstCard } = await publishedCard('Klima bakımı');
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '+905320000009', email: 'owner@example.test' });
    const payload = showcaseLeadPayload(category.slug, {
      customerPhone: '05321234567',
      customerEmail: 'Owner@example.test',
    });
    await proveShowcaseLeadPhone(ctx.prisma, payload.customerPhone as string);
    const before = await snapshot();

    expectIdentityConflict(await request(ctx.server).post(`/showcase/cards/${firstCard.id}/leads`).send(payload));
    expect(await snapshot()).toEqual(before);
  });
});

describe('POST /users by an operator', () => {
  async function adminCookie() {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN, phone: null });
    return loginAs(ctx.prisma, admin.id);
  }

  it('stores the number in E.164 and refuses every other spelling of one already on file', async () => {
    const cookie = await adminCookie();
    await createUser(ctx.prisma, { role: UserRole.CUSTOMER, phone: '05321234567', email: 'legacy@example.test' });

    const refused = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie)
      .send({ name: 'Yeni Operatör', email: 'op@example.test', phone: '+90 532 123 45 67' });
    expect(refused.status).toBe(409);
    expect(await ctx.prisma.user.findFirst({ where: { email: 'op@example.test' } })).toBeNull();

    const accepted = await request(ctx.server)
      .post('/users')
      .set('Cookie', cookie)
      .send({ name: 'Yeni Operatör', email: 'op@example.test', phone: '0532 765 43 21' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.phone).toBe('+905327654321');
  });
});
