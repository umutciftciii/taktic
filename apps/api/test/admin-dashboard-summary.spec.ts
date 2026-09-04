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

function fetchList(admin: Party, query = '') {
  return request(ctx.server)
    .get(`/admin/support/tickets${query}`)
    .set('Cookie', admin.cookie);
}

type ListedTicket = { id: string; status: SupportTicketStatus };
type TicketList = { items: ListedTicket[]; total: number };

/** The five-ticket fixture every case below shares: three in the backlog, two out of it. */
async function seedBacklog(admin: Party, customer: Party) {
  const openA = await openTicket(customer);
  const openB = await openTicket(customer);

  const inProgress = await openTicket(customer);
  await moveTo(admin, inProgress, SupportTicketStatus.IN_PROGRESS);

  const resolved = await openTicket(customer);
  await moveTo(admin, resolved, SupportTicketStatus.RESOLVED);

  const closed = await openTicket(customer);
  await moveTo(admin, closed, SupportTicketStatus.CLOSED);

  return { openA, openB, inProgress, resolved, closed };
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


/**
 * The card's number and the list's rows.
 *
 * These two used to disagree by construction: the summary counted OPEN and
 * IN_PROGRESS while the list could only be told one status at a time, so the
 * dashboard link named OPEN and opened a screen missing half of the figure it
 * had just shown. The list now takes a set, and what is asserted here is not
 * that both happen to be three — it is that the *same tickets* are on both
 * sides, by id.
 */
describe('the dashboard card and the filtered list', () => {
  it('name exactly the same tickets, by id', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const seeded = await seedBacklog(admin, customer);

    const summary = await fetchSummary(admin).expect(200);
    const list = await fetchList(admin, '?status=OPEN,IN_PROGRESS').expect(200);
    const body = list.body as TicketList;

    // The count on the card is the size of the list behind it...
    expect(body.total).toBe(summary.body.openSupportTickets);
    expect(body.total).toBe(3);

    // ...and it is the same three tickets, not merely the same number of them.
    expect(new Set(body.items.map((ticket) => ticket.id))).toEqual(
      new Set([seeded.openA, seeded.openB, seeded.inProgress]),
    );
  });

  it('leave the answered and the filed out of both', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const seeded = await seedBacklog(admin, customer);

    const list = await fetchList(admin, '?status=OPEN,IN_PROGRESS').expect(200);
    const body = list.body as TicketList;
    const listed = body.items.map((ticket) => ticket.id);

    expect(listed).not.toContain(seeded.resolved);
    expect(listed).not.toContain(seeded.closed);
    for (const ticket of body.items) {
      expect([SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS]).toContain(ticket.status);
    }
  });

  it('move together when a ticket is picked up and again when it is answered', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticketId = await openTicket(customer);

    const agree = async (expected: number) => {
      const summary = await fetchSummary(admin).expect(200);
      const list = await fetchList(admin, '?status=OPEN,IN_PROGRESS').expect(200);
      expect(summary.body.openSupportTickets).toBe(expected);
      expect((list.body as TicketList).total).toBe(expected);
    };

    await agree(1);

    // Picked up: still the operator's job, so still on both sides.
    await moveTo(admin, ticketId, SupportTicketStatus.IN_PROGRESS);
    await agree(1);

    // Answered: off both, together.
    await moveTo(admin, ticketId, SupportTicketStatus.RESOLVED);
    await agree(0);
  });
});

/**
 * Widening the filter widened nothing else.
 *
 * `?status=OPEN` is what every link written before this change carries, and
 * what the filter form on the support screen still submits when a single status
 * is chosen. It has to keep meaning exactly one status.
 */
describe('the single-status filter that existed before', () => {
  it('still returns exactly that status, for each of the four', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const seeded = await seedBacklog(admin, customer);

    const cases = [
      [SupportTicketStatus.OPEN, [seeded.openA, seeded.openB]],
      [SupportTicketStatus.IN_PROGRESS, [seeded.inProgress]],
      [SupportTicketStatus.RESOLVED, [seeded.resolved]],
      [SupportTicketStatus.CLOSED, [seeded.closed]],
    ] as const;

    for (const [status, expected] of cases) {
      const list = await fetchList(admin, `?status=${status}`).expect(200);
      const body = list.body as TicketList;

      expect(body.total, `?status=${status}`).toBe(expected.length);
      expect(new Set(body.items.map((ticket) => ticket.id))).toEqual(new Set(expected));
    }
  });

  it('still lists everything when no status is named', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    await seedBacklog(admin, customer);

    const listed = await fetchList(admin).expect(200);
    const empty = await fetchList(admin, '?status=').expect(200);

    expect((listed.body as TicketList).total).toBe(5);
    // An empty value has always meant "no filter" rather than "match nothing".
    expect((empty.body as TicketList).total).toBe(5);
  });
});

describe('the ways a caller may name a set of statuses', () => {
  it('reads a comma-separated set and a repeated parameter the same way', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    await seedBacklog(admin, customer);

    const comma = await fetchList(admin, '?status=OPEN,IN_PROGRESS').expect(200);
    const repeated = await fetchList(admin, '?status=OPEN&status=IN_PROGRESS').expect(200);
    const encoded = await fetchList(admin, '?status=OPEN%2CIN_PROGRESS').expect(200);

    expect((comma.body as TicketList).total).toBe(3);
    expect((repeated.body as TicketList).total).toBe(3);
    expect((encoded.body as TicketList).total).toBe(3);
  });

  it('collapses a repeat rather than counting a ticket twice', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    await seedBacklog(admin, customer);

    const list = await fetchList(admin, '?status=OPEN,OPEN').expect(200);
    const body = list.body as TicketList;

    expect(body.total).toBe(2);
    expect(new Set(body.items.map((ticket) => ticket.id)).size).toBe(2);
  });

  it('refuses a status that does not exist instead of listing everything', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);

    await fetchList(admin, '?status=OPENN').expect(400);
    await fetchList(admin, '?status=OPEN,NOT_A_STATUS').expect(400);
  });

  it('still refuses a customer, whatever they filter on', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    await fetchList(customer, '?status=OPEN,IN_PROGRESS').expect(403);
    await request(ctx.server).get('/admin/support/tickets?status=OPEN,IN_PROGRESS').expect(401);
  });
});
