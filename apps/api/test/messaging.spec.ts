import { OfferStatus, ServiceRequestStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCEPT_OFFER,
  createApprovedRequest,
  createCategory,
  createDiscoverableProvider,
  createTestApp,
  createUser,
  grantCredits,
  loginAs,
  offerPayload,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * Post-match messaging.
 *
 * The claim under test is one sentence: **a conversation exists only where a
 * match does, and only its two parties can reach it.** Everything below is
 * either a way of establishing that, or a way of trying to get around it —
 * a competing provider, a withdrawn one, a second customer, an anonymous
 * caller, an admin, a guessed thread id.
 *
 * Fixtures build the match through the real endpoints: the provider offers, the
 * customer accepts, and the accept cascade writes the ContactRevealEvent. That
 * matters — the reveal is the consent record messaging is gated on, so a test
 * that inserted one by hand would be proving something the product does not do.
 */

let ctx: TestContext;

const CATEGORY_COST = 2;
const DISCLOSURE_URL = 'https://taktic.example/aydinlatma';
const DISCLOSURE_VERSION = 'v1';

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  enableContactSharing();
  restoreRateLimit();
});

afterEach(() => {
  disableContactSharing();
  restoreRateLimit();
});

function enableContactSharing() {
  process.env.CONTACT_SHARING_ENABLED = 'true';
  process.env.CONTACT_DISCLOSURE_URL = DISCLOSURE_URL;
  process.env.CONTACT_DISCLOSURE_VERSION = DISCLOSURE_VERSION;
}

function disableContactSharing() {
  process.env.CONTACT_SHARING_ENABLED = 'false';
  delete process.env.CONTACT_DISCLOSURE_URL;
  delete process.env.CONTACT_DISCLOSURE_VERSION;
}

function restoreRateLimit() {
  delete process.env.MESSAGE_RATE_LIMIT_MAX;
  delete process.env.MESSAGE_RATE_LIMIT_WINDOW_SECONDS;
}

type Party = {
  userId: string;
  cookie: string;
};

async function addProviderWithOffer(categoryId: string, requestId: string) {
  const user = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, {
    userId: user.id,
    categoryId,
  });
  const cookie = await loginAs(ctx.prisma, user.id);
  await grantCredits(ctx.prisma, provider.id, 10);

  const created = await request(ctx.server)
    .post(`/providers/${provider.id}/requests/${requestId}/offers`)
    .set('Cookie', cookie)
    .send(offerPayload())
    .expect(201);

  return {
    providerId: provider.id as string,
    offerId: created.body.id as string,
    party: { userId: user.id, cookie } satisfies Party,
  };
}

/**
 * A completed match with a winner and a loser, built through the product.
 *
 * The loser is what makes most of the refusals below meaningful: they are a
 * real provider, on the same request, who really sent an offer — not a stranger
 * with no business here at all.
 */
async function matchedFixture() {
  const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
  const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
  const customer: Party = {
    userId: customerUser.id,
    cookie: await loginAs(ctx.prisma, customerUser.id),
  };

  const serviceRequest = await createApprovedRequest(ctx.prisma, {
    categoryId: category.id,
    customerId: customerUser.id,
  });

  const winner = await addProviderWithOffer(category.id, serviceRequest.id);
  const loser = await addProviderWithOffer(category.id, serviceRequest.id);

  await request(ctx.server)
    .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
    .set('Cookie', customer.cookie)
    .send(ACCEPT_OFFER)
    .expect(201);

  return { category, customerUser, customer, serviceRequest, winner, loser };
}

/** Opens (or re-opens) the conversation the way the product's screens do. */
async function resolveThread(party: Party, requestId: string, expectedStatus = 201) {
  return request(ctx.server)
    .post('/messages/threads/resolve')
    .set('Cookie', party.cookie)
    .send({ requestId })
    .expect(expectedStatus);
}

async function threadIdFor(party: Party, requestId: string) {
  const response = await resolveThread(party, requestId);
  return response.body.id as string;
}

/**
 * Not `async`: the supertest chain itself is returned so callers can go on
 * appending `.expect(...)`. Wrapping it in a promise would hand them a plain
 * Promise, which has no `.expect`.
 */
function send(party: Party, threadId: string, body: string, clientToken?: string) {
  return request(ctx.server)
    .post(`/messages/threads/${threadId}/messages`)
    .set('Cookie', party.cookie)
    .send({ body, ...(clientToken ? { clientToken } : {}) });
}

describe('opening a conversation', () => {
  it('gives both parties the same single thread', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();

    const fromCustomer = await resolveThread(customer, serviceRequest.id);
    expect(fromCustomer.body.created).toBe(true);
    expect(fromCustomer.body.viewerRole).toBe('CUSTOMER');

    const fromProvider = await resolveThread(winner.party, serviceRequest.id);
    // The same conversation, not a second one, and the provider's own view of it.
    expect(fromProvider.body.id).toBe(fromCustomer.body.id);
    expect(fromProvider.body.created).toBe(false);
    expect(fromProvider.body.viewerRole).toBe('PROVIDER');

    expect(await ctx.prisma.messageThread.count()).toBe(1);
  });

  it('is idempotent — opening it repeatedly never creates a second thread', async () => {
    const { customer, winner, serviceRequest } = await matchedFixture();

    await resolveThread(customer, serviceRequest.id);
    await resolveThread(customer, serviceRequest.id);
    await resolveThread(winner.party, serviceRequest.id);

    expect(await ctx.prisma.messageThread.count()).toBe(1);
  });

  it('names the counterpart, and carries nothing about how to reach them', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();

    const provider = await ctx.prisma.providerProfile.findUniqueOrThrow({
      where: { id: winner.providerId },
    });
    const requestRow = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });

    const response = await resolveThread(customer, serviceRequest.id);
    expect(response.body.counterpart.name).toBe(provider.businessName);

    // Everything the contact-sharing routes exist to guard stays with them.
    const serialized = JSON.stringify(response.body);
    for (const secret of [
      provider.phone,
      provider.email,
      provider.addressNote,
      requestRow.customerPhone,
      requestRow.customerEmail,
    ]) {
      if (secret) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});

describe('who cannot reach a conversation', () => {
  it('refuses a competing provider whose offer lost', async () => {
    const { customer, serviceRequest, loser } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    // Not through the match…
    await resolveThread(loser.party, serviceRequest.id, 404);
    // …and not by naming the thread either. The id is never what is checked.
    await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', loser.party.cookie)
      .expect(404);
    await send(loser.party, threadId, 'Merhaba').expect(404);
  });

  it('refuses a provider who withdrew before the customer chose', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customer: Party = {
      userId: customerUser.id,
      cookie: await loginAs(ctx.prisma, customerUser.id),
    };
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customerUser.id,
    });

    const withdrawn = await addProviderWithOffer(category.id, serviceRequest.id);
    await ctx.prisma.offer.update({
      where: { id: withdrawn.offerId },
      data: { status: OfferStatus.WITHDRAWN, withdrawnAt: new Date() },
    });

    const winner = await addProviderWithOffer(category.id, serviceRequest.id);
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .set('Cookie', customer.cookie)
      .send(ACCEPT_OFFER)
      .expect(201);

    await resolveThread(withdrawn.party, serviceRequest.id, 404);
    expect(
      (await request(ctx.server).get('/messages/threads').set('Cookie', withdrawn.party.cookie))
        .body,
    ).toEqual([]);
  });

  it('refuses a provider whose offer is still pending on an unmatched request', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const customerUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customer: Party = {
      userId: customerUser.id,
      cookie: await loginAs(ctx.prisma, customerUser.id),
    };
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customerUser.id,
    });
    const pending = await addProviderWithOffer(category.id, serviceRequest.id);

    // Nothing has been decided, so there is nothing to talk about — for either
    // of them.
    await resolveThread(pending.party, serviceRequest.id, 404);
    await resolveThread(customer, serviceRequest.id, 404);
  });

  it('refuses a different customer', async () => {
    const { serviceRequest, customer } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    const outsiderUser = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const outsider: Party = {
      userId: outsiderUser.id,
      cookie: await loginAs(ctx.prisma, outsiderUser.id),
    };

    await resolveThread(outsider, serviceRequest.id, 404);
    await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', outsider.cookie)
      .expect(404);
    await send(outsider, threadId, 'Merhaba').expect(404);
    expect(
      (await request(ctx.server).get('/messages/threads').set('Cookie', outsider.cookie)).body,
    ).toEqual([]);
  });

  it('refuses an anonymous caller with 401 on every route', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await request(ctx.server).get('/messages/threads').expect(401);
    await request(ctx.server).get('/messages/unread-count').expect(401);
    await request(ctx.server).get(`/messages/threads/${threadId}`).expect(401);
    await request(ctx.server).get(`/messages/threads/${threadId}/messages`).expect(401);
    await request(ctx.server)
      .post(`/messages/threads/${threadId}/messages`)
      .send({ body: 'Merhaba' })
      .expect(401);
    await request(ctx.server)
      .post('/messages/threads/resolve')
      .send({ requestId: serviceRequest.id })
      .expect(401);
  });

  it('refuses an admin: reading message content is not an administrative power', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);
    await send(customer, threadId, 'Yarın uygun musunuz?').expect(201);

    const adminUser = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    const adminCookie = await loginAs(ctx.prisma, adminUser.id);

    // The role guard refuses before anything is read, so no branch of this
    // module ever sees an admin caller.
    await request(ctx.server).get('/messages/threads').set('Cookie', adminCookie).expect(403);
    await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', adminCookie)
      .expect(403);
    await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages`)
      .set('Cookie', adminCookie)
      .expect(403);
    void winner;
  });

  it('refuses a thread id that does not exist, with the same answer as one that does', async () => {
    const { customer } = await matchedFixture();
    await request(ctx.server)
      .get('/messages/threads/clzzzzzzzzzzzzzzzzzzzzzzzz')
      .set('Cookie', customer.cookie)
      .expect(404);
  });
});

describe('consent is what opens the channel', () => {
  it('refuses when the match carries no ContactRevealEvent', async () => {
    // The whole match made with sharing off: everything else is identical, and
    // the one thing missing is the record of the customer's consent.
    disableContactSharing();
    const { customer, serviceRequest, winner } = await matchedFixture();
    expect(await ctx.prisma.contactRevealEvent.count()).toBe(0);

    // Turned on afterwards. The consent still does not exist, so neither does
    // the conversation — a flag flipped later cannot create an agreement.
    enableContactSharing();

    const refusal = await resolveThread(customer, serviceRequest.id, 409);
    expect(refusal.body.code).toBe('MESSAGE_THREAD_UNAVAILABLE');
    expect(refusal.body.reason).toBe('not-recorded');

    await resolveThread(winner.party, serviceRequest.id, 409);
    expect(await ctx.prisma.messageThread.count()).toBe(0);
  });

  it('refuses while contact sharing is switched off, and says so', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    await resolveThread(customer, serviceRequest.id);

    disableContactSharing();
    const refusal = await resolveThread(customer, serviceRequest.id, 409);
    expect(refusal.body.reason).toBe('sharing-off');
  });

  it('refuses a guest request that no account owns', async () => {
    const category = await createCategory(ctx.prisma, 'Klima', { offerCreditCost: CATEGORY_COST });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: null,
    });
    const winner = await addProviderWithOffer(category.id, serviceRequest.id);

    // An anonymous request can still be matched — the accept route allows it —
    // but there is nobody to sign in as on the customer side.
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/offers/${winner.offerId}/action`)
      .send(ACCEPT_OFFER)
      .expect(201);

    const refusal = await resolveThread(winner.party, serviceRequest.id, 409);
    expect(refusal.body.reason).toBe('customer-not-registered');
    expect(await ctx.prisma.messageThread.count()).toBe(0);
  });
});

describe('sending and reading', () => {
  it('carries a message both ways, in a deterministic order', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Merhaba, yarın uygun musunuz?').expect(201);
    await send(winner.party, threadId, 'Merhaba, 14:00 uygun.').expect(201);
    await send(customer, threadId, 'Harika, bekliyorum.').expect(201);

    const thread = await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);

    expect(thread.body.messages.map((message: { body: string }) => message.body)).toEqual([
      'Merhaba, yarın uygun musunuz?',
      'Merhaba, 14:00 uygun.',
      'Harika, bekliyorum.',
    ]);
    expect(thread.body.messages.map((message: { senderRole: string }) => message.senderRole)).toEqual([
      'CUSTOMER',
      'PROVIDER',
      'CUSTOMER',
    ]);
  });

  it('stamps the time on the server, ignoring anything the client sends', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    // `forbidNonWhitelisted` refuses the attempt outright, which is the
    // strongest possible version of "the client does not set the clock".
    await request(ctx.server)
      .post(`/messages/threads/${threadId}/messages`)
      .set('Cookie', customer.cookie)
      .send({ body: 'Merhaba', createdAt: '1999-01-01T00:00:00.000Z' })
      .expect(400);

    const sent = await send(customer, threadId, 'Merhaba').expect(201);
    expect(Date.now() - Date.parse(sent.body.createdAt)).toBeLessThan(5_000);
  });

  it('trims, refuses an empty body and caps the length', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, '   ').expect(400);
    await send(customer, threadId, '\n\t  \n').expect(400);
    await send(customer, threadId, 'a'.repeat(2001)).expect(400);

    const trimmed = await send(customer, threadId, '  Merhaba  ').expect(201);
    expect(trimmed.body.body).toBe('Merhaba');

    const atLimit = await send(customer, threadId, 'b'.repeat(2000)).expect(201);
    expect(atLimit.body.body).toHaveLength(2000);
  });

  it('stores a body that looks like markup as the characters it is', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    const payload = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const sent = await send(customer, threadId, payload).expect(201);

    // Stored verbatim — not escaped here, not sanitised into something else.
    // Escaping is the renderer's job and doing it twice would show a customer
    // "&lt;script&gt;" where they typed "<script>". What matters is that the
    // body is data: it is never parsed as markup on the way in or out.
    expect(sent.body.body).toBe(payload);

    const seen = await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(seen.body.messages[0].body).toBe(payload);
  });

  it('drops control characters a keyboard cannot produce, and keeps newlines', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    // A bell, a null and an escape wrapped around ordinary text: none of them
    // are typed by a person, and all three are how a message body gets a second
    // life in a terminal, a log line or a CSV somebody opens later.
    const hostile = 'Bir\u0007 satir\u0000\nIkinci\u001b satir';
    const sent = await send(customer, threadId, hostile).expect(201);

    expect(sent.body.body).toBe('Bir satir\nIkinci satir');
    // The newline a person really did type survives.
    expect(sent.body.body).toContain('\n');
  });
});

describe('duplicate submissions', () => {
  it('returns the original message when the same idempotency key arrives twice', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    const first = await send(customer, threadId, 'Merhaba', 'token-1').expect(201);
    const second = await send(customer, threadId, 'Merhaba', 'token-1').expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(await ctx.prisma.message.count({ where: { threadId } })).toBe(1);
  });

  it('keeps two genuinely different messages that happen to say the same thing', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Merhaba', 'token-a').expect(201);
    await send(customer, threadId, 'Merhaba', 'token-b').expect(201);

    expect(await ctx.prisma.message.count({ where: { threadId } })).toBe(2);
  });

  it('does not let one party\'s key collide with the other\'s', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Müşteri mesajı', 'shared-token').expect(201);
    const providerSend = await send(winner.party, threadId, 'Hizmet veren mesajı', 'shared-token');

    // A key is scoped to the thread, so the second sender's own new message
    // must not be swallowed as the first sender's duplicate.
    expect(providerSend.status).toBe(201);
    expect(providerSend.body.body).toBe('Hizmet veren mesajı');
    expect(await ctx.prisma.message.count({ where: { threadId } })).toBe(2);
  });
});

describe('rate limiting', () => {
  it('refuses a sender past the limit, and lets the other party keep writing', async () => {
    process.env.MESSAGE_RATE_LIMIT_MAX = '3';
    process.env.MESSAGE_RATE_LIMIT_WINDOW_SECONDS = '60';

    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    for (let index = 0; index < 3; index += 1) {
      await send(customer, threadId, `Mesaj ${index}`).expect(201);
    }

    const refused = await send(customer, threadId, 'Bir tane daha').expect(429);
    expect(refused.body.code).toBe('MESSAGE_RATE_LIMITED');
    expect(refused.body.retryAfterSeconds).toBe(60);

    // The limit is per account, so the counterpart is unaffected.
    await send(winner.party, threadId, 'Ben hâlâ yazabiliyorum').expect(201);

    expect(await ctx.prisma.message.count({ where: { threadId } })).toBe(4);
  });

  it('lets the sender continue once the window has passed', async () => {
    process.env.MESSAGE_RATE_LIMIT_MAX = '2';
    process.env.MESSAGE_RATE_LIMIT_WINDOW_SECONDS = '60';

    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Bir').expect(201);
    await send(customer, threadId, 'İki').expect(201);
    await send(customer, threadId, 'Üç').expect(429);

    // The window is a rolling one over the messages table, so ageing the rows
    // is exactly the state a sender who waited a minute is in.
    await ctx.prisma.message.updateMany({
      where: { threadId },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });

    await send(customer, threadId, 'Üç').expect(201);
  });
});

describe('unread counts and read receipts', () => {
  it('raises the counterpart\'s unread count, and never the sender\'s own', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Bir').expect(201);
    await send(customer, threadId, 'İki').expect(201);

    const providerBadge = await request(ctx.server)
      .get('/messages/unread-count')
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(providerBadge.body.total).toBe(2);
    expect(providerBadge.body.threads).toBe(1);

    const customerBadge = await request(ctx.server)
      .get('/messages/unread-count')
      .set('Cookie', customer.cookie)
      .expect(200);
    expect(customerBadge.body.total).toBe(0);
  });

  it('clears on read, and the counterpart sees only that it was read', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);
    await send(customer, threadId, 'Merhaba').expect(201);

    // Before the provider reads it, the customer's own view says so.
    const beforeRead = await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', customer.cookie)
      .expect(200);
    expect(beforeRead.body.counterpartHasRead).toBe(false);

    await request(ctx.server)
      .post(`/messages/threads/${threadId}/read`)
      .set('Cookie', winner.party.cookie)
      .expect(201);

    const afterRead = await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', customer.cookie)
      .expect(200);
    expect(afterRead.body.counterpartHasRead).toBe(true);

    // A boolean and nothing else: no timestamp, no device, no address.
    const serialized = JSON.stringify(afterRead.body);
    expect(serialized).not.toContain('providerLastReadAt');
    expect(serialized).not.toContain('ipAddress');
    expect(serialized).not.toContain('userAgent');

    const badge = await request(ctx.server)
      .get('/messages/unread-count')
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(badge.body.total).toBe(0);
  });

  it('goes back up when the counterpart writes again after a read', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Bir').expect(201);
    await request(ctx.server)
      .post(`/messages/threads/${threadId}/read`)
      .set('Cookie', winner.party.cookie)
      .expect(201);
    await send(customer, threadId, 'İki').expect(201);

    const badge = await request(ctx.server)
      .get('/messages/unread-count')
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(badge.body.total).toBe(1);
  });
});

describe('pagination', () => {
  it('pages backwards through history without repeating or losing a message', async () => {
    process.env.MESSAGE_RATE_LIMIT_MAX = '100';
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    for (let index = 0; index < 12; index += 1) {
      await send(customer, threadId, `Mesaj ${index}`).expect(201);
    }

    const firstPage = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?limit=5`)
      .set('Cookie', winner.party.cookie)
      .expect(200);

    // The most recent five, oldest-first within the page.
    expect(firstPage.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Mesaj 7',
      'Mesaj 8',
      'Mesaj 9',
      'Mesaj 10',
      'Mesaj 11',
    ]);
    expect(firstPage.body.hasMoreBefore).toBe(true);

    const secondPage = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?limit=5&before=${firstPage.body.olderCursor}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(secondPage.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Mesaj 2',
      'Mesaj 3',
      'Mesaj 4',
      'Mesaj 5',
      'Mesaj 6',
    ]);

    const lastPage = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?limit=5&before=${secondPage.body.olderCursor}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(lastPage.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Mesaj 0',
      'Mesaj 1',
    ]);
    expect(lastPage.body.hasMoreBefore).toBe(false);
  });

  it('returns only what is new when polling with a cursor', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await send(customer, threadId, 'Bir').expect(201);
    const opened = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages`)
      .set('Cookie', winner.party.cookie)
      .expect(200);

    // Nothing has happened since, so a poll is empty rather than a re-read.
    const quiet = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?after=${opened.body.latestCursor}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(quiet.body.messages).toEqual([]);

    await send(customer, threadId, 'İki').expect(201);

    const polled = await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?after=${opened.body.latestCursor}`)
      .set('Cookie', winner.party.cookie)
      .expect(200);
    expect(polled.body.messages.map((m: { body: string }) => m.body)).toEqual(['İki']);
  });

  it('refuses a cursor it did not issue, and a request that asks both directions', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?before=not-a-cursor`)
      .set('Cookie', customer.cookie)
      .expect(400);

    await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?before=aaaa&after=bbbb`)
      .set('Cookie', customer.cookie)
      .expect(400);
  });

  it('caps how much one page may ask for', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);

    await request(ctx.server)
      .get(`/messages/threads/${threadId}/messages?limit=5000`)
      .set('Cookie', customer.cookie)
      .expect(400);
  });
});

describe('a conversation does not outlive its match', () => {
  it('closes when the request stops being matched to this offer', async () => {
    const { customer, serviceRequest, winner } = await matchedFixture();
    const threadId = await threadIdFor(customer, serviceRequest.id);
    await send(customer, threadId, 'Merhaba').expect(201);

    // The thread row still exists and still names both parties. The chain
    // behind it does not, and the chain is what authorises.
    await ctx.prisma.serviceRequest.update({
      where: { id: serviceRequest.id },
      data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: new Date() },
    });

    await request(ctx.server)
      .get(`/messages/threads/${threadId}`)
      .set('Cookie', customer.cookie)
      .expect(403);
    await send(winner.party, threadId, 'Hâlâ orada mısınız?').expect(403);
  });
});

describe('the inbox', () => {
  it('lists only the caller\'s own conversations, most recent first', async () => {
    const first = await matchedFixture();
    const firstThreadId = await threadIdFor(first.customer, first.serviceRequest.id);

    // A second, unrelated match belonging to somebody else entirely.
    const second = await matchedFixture();
    const secondThreadId = await threadIdFor(second.customer, second.serviceRequest.id);
    await send(second.customer, secondThreadId, 'İkinci konuşma').expect(201);
    await send(first.customer, firstThreadId, 'Birinci konuşma').expect(201);

    const inbox = await request(ctx.server)
      .get('/messages/threads')
      .set('Cookie', first.customer.cookie)
      .expect(200);

    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].id).toBe(firstThreadId);
    expect(inbox.body[0].lastMessage.body).toBe('Birinci konuşma');
    expect(inbox.body[0].request.category.name).toBe(first.category.name);
  });

  it('shows an opened conversation nobody has written in yet', async () => {
    const { customer, serviceRequest } = await matchedFixture();
    await resolveThread(customer, serviceRequest.id);

    const inbox = await request(ctx.server)
      .get('/messages/threads')
      .set('Cookie', customer.cookie)
      .expect(200);

    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].lastMessage).toBeNull();
    expect(inbox.body[0].unreadCount).toBe(0);
    expect(inbox.body[0].counterpartHasRead).toBe(false);
  });
});
