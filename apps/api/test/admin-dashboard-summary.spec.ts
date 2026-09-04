import { SupportTicketStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * The admin dashboard's summary.
 *
 * Two claims. **The support figure is the backlog** — the tickets somebody
 * still has to answer, which is OPEN plus IN_PROGRESS and nothing else; a
 * resolved or closed ticket is finished work and counting it would put a number
 * on the dashboard no operator could ever bring down. And **the summary is the
 * operator's alone**: it names how many customers are waiting and how many
 * providers are unapproved, so a customer, a provider or an anonymous caller
 * asking for it gets a refusal rather than a redacted answer.
 *
 * Tickets are opened and moved through the real endpoints rather than inserted.
 * A row written by hand could hold a status the transition table forbids, and
 * the count would then be asserted against a ticket the product cannot produce.
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

type Party = { userId: string; cookie: string };

async function signIn(role: UserRole): Promise<Party> {
  const user = await createUser(ctx.prisma, { role });
  return { userId: user.id, cookie: await loginAs(ctx.prisma, user.id) };
}

async function openTicket(customer: Party): Promise<string> {
  const response = await request(ctx.server)
    .post('/support/tickets')
    .set('Cookie', customer.cookie)
    .send({
      subject: 'Faturam ulaşmadı',
      message: 'Geçen haftaki talebimin faturası elime geçmedi.',
    })
    .expect(201);

  return (response.body as { id: string }).id;
}

/** Walks a ticket to `target` along the only path the transition table allows. */
async function moveTo(admin: Party, ticketId: string, target: SupportTicketStatus) {
  const path: SupportTicketStatus[] =
    target === SupportTicketStatus.IN_PROGRESS
      ? [SupportTicketStatus.IN_PROGRESS]
      : target === SupportTicketStatus.RESOLVED
        ? [SupportTicketStatus.RESOLVED]
        : [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED];

  for (const status of path) {
    await request(ctx.server)
      .post(`/admin/support/tickets/${ticketId}/status`)
      .set('Cookie', admin.cookie)
      .send({ status })
      .expect(200);
  }
}

function fetchSummary(admin: Party) {
  return request(ctx.server).get('/dashboard/admin-summary').set('Cookie', admin.cookie);
}

describe('the open support tickets figure', () => {
  it('is zero on a marketplace where nobody has asked for help', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);

    const response = await fetchSummary(admin).expect(200);

    expect(response.body.openSupportTickets).toBe(0);
  });

  it('counts OPEN and IN_PROGRESS, and excludes RESOLVED and CLOSED', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);

    // Two left where the customer put them, one picked up, one answered and one
    // filed away: four tickets in the backlog's two statuses, two outside it.
    await openTicket(customer);
    await openTicket(customer);
    await moveTo(admin, await openTicket(customer), SupportTicketStatus.IN_PROGRESS);
    await moveTo(admin, await openTicket(customer), SupportTicketStatus.IN_PROGRESS);
    await moveTo(admin, await openTicket(customer), SupportTicketStatus.RESOLVED);
    await moveTo(admin, await openTicket(customer), SupportTicketStatus.CLOSED);

    const response = await fetchSummary(admin).expect(200);

    expect(response.body.openSupportTickets).toBe(4);
  });

  it('drops a ticket out of the count the moment it is resolved', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticketId = await openTicket(customer);

    const before = await fetchSummary(admin).expect(200);
    expect(before.body.openSupportTickets).toBe(1);

    await moveTo(admin, ticketId, SupportTicketStatus.RESOLVED);

    const after = await fetchSummary(admin).expect(200);
    expect(after.body.openSupportTickets).toBe(0);
  });
});

describe('who may read the summary', () => {
  it('answers an operator with every figure the dashboard renders', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);

    const response = await fetchSummary(admin).expect(200);

    expect(response.body).toEqual({
      totalRequests: 0,
      pendingRequests: 0,
      inReviewRequests: 0,
      approvedProviders: 0,
      pendingProviders: 0,
      totalOffers: 0,
      refundableOffers: 0,
      packagePurchases: 0,
      openSupportTickets: 0,
    });
  });

  it('refuses a customer and a provider', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);

    await fetchSummary(customer).expect(403);
    await fetchSummary(provider).expect(403);
  });

  it('refuses an anonymous caller', async () => {
    await request(ctx.server).get('/dashboard/admin-summary').expect(401);
  });
});
