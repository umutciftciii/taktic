import { SupportTicketStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '../src/common/support-ticket-limits';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * Customer support tickets.
 *
 * The claim under test is two sentences: **a ticket belongs to the account that
 * opened it and to nobody else, and its status only ever moves the way the
 * transition table allows.** Everything below either establishes one of those
 * or tries to get around it — a second customer, a provider, an anonymous
 * caller, a guessed id, a forged owner in the body, a closed ticket, an illegal
 * transition, a whitespace message.
 *
 * Every fixture goes through the real endpoints. A ticket inserted by hand
 * would prove something the product does not do, and the ownership rule in
 * particular is only meaningful if the row was written by the create path that
 * takes its owner from the session.
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

async function openTicket(customer: Party, overrides: { subject?: string; message?: string } = {}) {
  const response = await request(ctx.server)
    .post('/support/tickets')
    .set('Cookie', customer.cookie)
    .send({
      subject: overrides.subject ?? 'Faturam ulaşmadı',
      message: overrides.message ?? 'Geçen haftaki talebimin faturası elime geçmedi.',
    })
    .expect(201);

  return response.body as { id: string; status: SupportTicketStatus };
}

function moveStatus(admin: Party, ticketId: string, status: SupportTicketStatus) {
  return request(ctx.server)
    .post(`/admin/support/tickets/${ticketId}/status`)
    .set('Cookie', admin.cookie)
    .send({ status });
}

describe('a customer and their own tickets', () => {
  it('opens a ticket, finds it in their list, reads it and replies', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    const created = await openTicket(customer, {
      subject: 'Faturam ulaşmadı',
      message: 'Geçen haftaki talebimin faturası elime geçmedi.',
    });

    expect(created.status).toBe(SupportTicketStatus.OPEN);

    const list = await request(ctx.server)
      .get('/support/tickets')
      .set('Cookie', customer.cookie)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.id, subject: 'Faturam ulaşmadı' });

    const detail = await request(ctx.server)
      .get(`/support/tickets/${created.id}`)
      .set('Cookie', customer.cookie)
      .expect(200);

    // The opening message is the first thing on the timeline, not a column the
    // screen has to remember to prepend.
    expect(detail.body.canReply).toBe(true);
    expect(detail.body.timeline).toHaveLength(1);
    expect(detail.body.timeline[0]).toMatchObject({
      kind: 'MESSAGE',
      authorRole: 'CUSTOMER',
      mine: true,
      body: 'Geçen haftaki talebimin faturası elime geçmedi.',
    });

    await request(ctx.server)
      .post(`/support/tickets/${created.id}/messages`)
      .set('Cookie', customer.cookie)
      .send({ body: 'Ek olarak talep numaram TR-1234.' })
      .expect(201);

    const afterReply = await request(ctx.server)
      .get(`/support/tickets/${created.id}`)
      .set('Cookie', customer.cookie)
      .expect(200);

    expect(afterReply.body.timeline).toHaveLength(2);
    expect(afterReply.body.timeline[1].body).toBe('Ek olarak talep numaram TR-1234.');
    // The activity mark moved with the reply; the creation time did not.
    expect(new Date(afterReply.body.lastActivityAt).getTime()).toBeGreaterThanOrEqual(
      new Date(afterReply.body.createdAt).getTime(),
    );
  });

  it('takes the owner from the session and ignores one supplied in the body', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const other = await signIn(UserRole.CUSTOMER);

    // `forbidNonWhitelisted` is on, so naming a field the DTO does not have is
    // refused outright rather than quietly dropped. Either way the owner is not
    // something a caller gets to choose — this proves the stronger of the two.
    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customer.cookie)
      .send({
        subject: 'Başkasının adına',
        message: 'Bu talep başkasına yazılsın.',
        customerId: other.userId,
      })
      .expect(400);

    const stolen = await ctx.prisma.supportTicket.findMany({ where: { customerId: other.userId } });
    expect(stolen).toHaveLength(0);
  });
});

describe('another customer, a provider, and a stranger', () => {
  it("cannot see, read or write another customer's ticket", async () => {
    const owner = await signIn(UserRole.CUSTOMER);
    const intruder = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(owner);

    // Not in their list…
    const list = await request(ctx.server)
      .get('/support/tickets')
      .set('Cookie', intruder.cookie)
      .expect(200);
    expect(list.body).toHaveLength(0);

    // …not readable by id, and the refusal is the same 404 a made-up id gets,
    // so the response cannot be used to find out that a ticket exists.
    await request(ctx.server)
      .get(`/support/tickets/${ticket.id}`)
      .set('Cookie', intruder.cookie)
      .expect(404);

    await request(ctx.server)
      .get('/support/tickets/does-not-exist')
      .set('Cookie', intruder.cookie)
      .expect(404);

    // …and not writable.
    await request(ctx.server)
      .post(`/support/tickets/${ticket.id}/messages`)
      .set('Cookie', intruder.cookie)
      .send({ body: 'Bu benim talebim değil.' })
      .expect(404);

    const messages = await ctx.prisma.supportTicketMessage.findMany({
      where: { ticketId: ticket.id },
    });
    expect(messages).toHaveLength(1);
  });

  it('refuses a provider and an anonymous caller on every customer route', async () => {
    const owner = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(owner);

    await request(ctx.server).get('/support/tickets').set('Cookie', provider.cookie).expect(403);
    await request(ctx.server)
      .get(`/support/tickets/${ticket.id}`)
      .set('Cookie', provider.cookie)
      .expect(403);
    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', provider.cookie)
      .send({ subject: 'Konu', message: 'Mesaj' })
      .expect(403);

    await request(ctx.server).get('/support/tickets').expect(401);
    await request(ctx.server)
      .post('/support/tickets')
      .send({ subject: 'Konu', message: 'Mesaj' })
      .expect(401);
  });

  it('refuses every role but SUPER_ADMIN on the admin routes', async () => {
    const owner = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(owner);

    // The owner of the ticket included: the admin surface is not a wider view
    // of the customer's own, it is a different surface with a different guard.
    await request(ctx.server).get('/admin/support/tickets').set('Cookie', owner.cookie).expect(403);
    await request(ctx.server)
      .get(`/admin/support/tickets/${ticket.id}`)
      .set('Cookie', provider.cookie)
      .expect(403);
    await request(ctx.server)
      .post(`/admin/support/tickets/${ticket.id}/status`)
      .set('Cookie', owner.cookie)
      .send({ status: SupportTicketStatus.CLOSED })
      .expect(403);
    await request(ctx.server).get('/admin/support/tickets').expect(401);
  });
});

describe('the operator', () => {
  it('lists every ticket, filters by status, pages, replies and resolves', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const first = await signIn(UserRole.CUSTOMER);
    const second = await signIn(UserRole.CUSTOMER);

    const a = await openTicket(first, { subject: 'İlk konu' });
    const b = await openTicket(second, { subject: 'İkinci konu' });

    const list = await request(ctx.server)
      .get('/admin/support/tickets')
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(list.body.total).toBe(2);
    expect(list.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // The list carries the owner an operator needs in order to answer.
    expect(list.body.items[0].customer.id).toBeTruthy();
    expect(list.body.statusCounts.OPEN).toBe(2);

    // An operator answers one of them and marks it in progress.
    await request(ctx.server)
      .post(`/admin/support/tickets/${a.id}/messages`)
      .set('Cookie', admin.cookie)
      .send({ body: 'Faturanızı yeniden gönderdik.' })
      .expect(201);

    await moveStatus(admin, a.id, SupportTicketStatus.IN_PROGRESS).expect(200);

    const filtered = await request(ctx.server)
      .get('/admin/support/tickets?status=IN_PROGRESS')
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].id).toBe(a.id);
    expect(filtered.body.statusCounts).toMatchObject({ OPEN: 1, IN_PROGRESS: 1 });

    const paged = await request(ctx.server)
      .get('/admin/support/tickets?page=1&pageSize=1')
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.hasNextPage).toBe(true);

    // And the customer sees the operator's reply and the status change on their
    // own timeline, distinguishable from one another.
    const detail = await request(ctx.server)
      .get(`/support/tickets/${a.id}`)
      .set('Cookie', first.cookie)
      .expect(200);

    expect(detail.body.status).toBe(SupportTicketStatus.IN_PROGRESS);
    expect(detail.body.timeline.map((entry: { kind: string }) => entry.kind)).toEqual([
      'MESSAGE',
      'MESSAGE',
      'STATUS_CHANGE',
    ]);
    expect(detail.body.timeline[1]).toMatchObject({ authorRole: 'ADMIN', mine: false });
    expect(detail.body.timeline[2]).toMatchObject({
      kind: 'STATUS_CHANGE',
      fromStatus: SupportTicketStatus.OPEN,
      toStatus: SupportTicketStatus.IN_PROGRESS,
    });
  });

  it('walks a ticket through every legal transition and stamps the timestamps', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);
    // Back down again: an operator may put a ticket they picked up back in the
    // queue.
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(200);
    const resolved = await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.closedAt).toBeNull();

    const closed = await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);
    expect(closed.body.closedAt).not.toBeNull();
    // Resolving is not undone by closing; both facts stay on the row.
    expect(closed.body.resolvedAt).not.toBeNull();

    const changes = await ctx.prisma.supportTicketStatusChange.findMany({
      where: { ticketId: ticket.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(changes.map((change) => change.toStatus)).toEqual([
      SupportTicketStatus.IN_PROGRESS,
      SupportTicketStatus.OPEN,
      SupportTicketStatus.RESOLVED,
      SupportTicketStatus.CLOSED,
    ]);
    // Every one of them names the operator who made it.
    expect(changes.every((change) => change.changedById === admin.userId)).toBe(true);
  });

  it('refuses every transition the table does not allow', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    // OPEN cannot jump straight to CLOSED, and cannot "transition" to itself.
    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(409);
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(409);

    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);

    // A resolved ticket may only be closed — not re-opened, not put back in
    // progress.
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(409);
    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(409);

    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);

    // And a closed ticket is terminal: nothing re-opens it.
    for (const status of [
      SupportTicketStatus.OPEN,
      SupportTicketStatus.IN_PROGRESS,
      SupportTicketStatus.RESOLVED,
    ]) {
      const refused = await moveStatus(admin, ticket.id, status).expect(409);
      expect(refused.body.code).toBe('SUPPORT_TICKET_INVALID_TRANSITION');
    }

    const stored = await ctx.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(stored.status).toBe(SupportTicketStatus.CLOSED);
    // Only the two changes that were allowed were recorded; refusals leave no
    // trace on the permanent timeline.
    const changes = await ctx.prisma.supportTicketStatusChange.count({
      where: { ticketId: ticket.id },
    });
    expect(changes).toBe(2);
  });

  it('rejects a status that is not one of the four', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await request(ctx.server)
      .post(`/admin/support/tickets/${ticket.id}/status`)
      .set('Cookie', admin.cookie)
      .send({ status: 'DELETED' })
      .expect(400);
  });

  it('has no way to open a ticket for a customer', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);

    // There is no create route on the admin surface at all — Nest answers 404
    // because nothing is mapped, which is the strongest form of "cannot".
    await request(ctx.server)
      .post('/admin/support/tickets')
      .set('Cookie', admin.cookie)
      .send({ subject: 'Müşteri adına', message: 'Müşteri adına açılan talep.' })
      .expect(404);

    expect(await ctx.prisma.supportTicket.count({ where: { customerId: customer.userId } })).toBe(
      0,
    );
  });
});

describe('a ticket that has stopped taking messages', () => {
  it('refuses the customer on a resolved ticket and both sides on a closed one', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);

    const refused = await request(ctx.server)
      .post(`/support/tickets/${ticket.id}/messages`)
      .set('Cookie', customer.cookie)
      .send({ body: 'Hâlâ çözülmedi.' })
      .expect(409);
    expect(refused.body.code).toBe('SUPPORT_TICKET_NOT_WRITABLE');

    // The screen says so too, so the composer is not offered in the first place.
    const detail = await request(ctx.server)
      .get(`/support/tickets/${ticket.id}`)
      .set('Cookie', customer.cookie)
      .expect(200);
    expect(detail.body.canReply).toBe(false);

    // An operator may still add the detail they promised while it is resolved…
    await request(ctx.server)
      .post(`/admin/support/tickets/${ticket.id}/messages`)
      .set('Cookie', admin.cookie)
      .send({ body: 'Ek bilgi: iade bugün yapıldı.' })
      .expect(201);

    // …and nobody may once it is closed.
    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);

    await request(ctx.server)
      .post(`/support/tickets/${ticket.id}/messages`)
      .set('Cookie', customer.cookie)
      .send({ body: 'Bir sorum daha var.' })
      .expect(409);

    const adminRefused = await request(ctx.server)
      .post(`/admin/support/tickets/${ticket.id}/messages`)
      .set('Cookie', admin.cookie)
      .send({ body: 'Kapalı talebe yazıyorum.' })
      .expect(409);
    expect(adminRefused.body.code).toBe('SUPPORT_TICKET_NOT_WRITABLE');

    expect(await ctx.prisma.supportTicketMessage.count({ where: { ticketId: ticket.id } })).toBe(2);
  });

  it('lets the customer open a new ticket instead', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const first = await openTicket(customer);

    await moveStatus(admin, first.id, SupportTicketStatus.RESOLVED).expect(200);
    await moveStatus(admin, first.id, SupportTicketStatus.CLOSED).expect(200);

    const second = await openTicket(customer, { subject: 'Devam eden sorun' });
    expect(second.status).toBe(SupportTicketStatus.OPEN);

    const list = await request(ctx.server)
      .get('/support/tickets')
      .set('Cookie', customer.cookie)
      .expect(200);
    expect(list.body).toHaveLength(2);
  });
});

describe('what may be written into a ticket', () => {
  it('refuses an empty, whitespace-only or missing subject and message', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    for (const payload of [
      { subject: '', message: 'Gerçek mesaj.' },
      { subject: '   ', message: 'Gerçek mesaj.' },
      { subject: '\n\t ', message: 'Gerçek mesaj.' },
      { subject: 'Gerçek konu', message: '' },
      { subject: 'Gerçek konu', message: '   \n  ' },
      { subject: 'Gerçek konu' },
      { message: 'Gerçek mesaj.' },
    ]) {
      await request(ctx.server)
        .post('/support/tickets')
        .set('Cookie', customer.cookie)
        .send(payload)
        .expect(400);
    }

    expect(await ctx.prisma.supportTicket.count()).toBe(0);
  });

  it('refuses a whitespace-only reply', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await request(ctx.server)
      .post(`/support/tickets/${ticket.id}/messages`)
      .set('Cookie', customer.cookie)
      .send({ body: '   \n\t  ' })
      .expect(400);

    expect(await ctx.prisma.supportTicketMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
  });

  it('accepts text exactly at both limits and refuses one character more', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    const subject = 'k'.repeat(SUPPORT_TICKET_SUBJECT_MAX_LENGTH);
    const message = 'm'.repeat(SUPPORT_TICKET_MESSAGE_MAX_LENGTH);

    const created = await openTicket(customer, { subject, message });
    const stored = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: created.id },
      include: { messages: true },
    });
    expect(stored.subject).toHaveLength(SUPPORT_TICKET_SUBJECT_MAX_LENGTH);
    expect(stored.messages[0]!.body).toHaveLength(SUPPORT_TICKET_MESSAGE_MAX_LENGTH);

    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customer.cookie)
      .send({ subject: `${subject}x`, message: 'Kısa mesaj.' })
      .expect(400);

    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customer.cookie)
      .send({ subject: 'Kısa konu', message: `${message}x` })
      .expect(400);
  });

  it('counts the limit in the same units the browser does', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    // Emoji are two UTF-16 code units each. A textarea's `maxLength` counts
    // them that way and so must the server, or the counter on screen and the
    // server's answer disagree — see MaxCodeUnitLength.
    const atLimit = '😀'.repeat(SUPPORT_TICKET_MESSAGE_MAX_LENGTH / 2);
    expect(atLimit.length).toBe(SUPPORT_TICKET_MESSAGE_MAX_LENGTH);

    await openTicket(customer, { subject: 'Emoji', message: atLimit });

    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customer.cookie)
      .send({ subject: 'Emoji', message: `${atLimit}😀` })
      .expect(400);
  });

  it('stores the text as typed, trims it, and strips control characters', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    const created = await openTicket(customer, {
      subject: '  Fatura \u0000  hatası\n ',
      message: '  <script>alert(1)</script>\u0007 satır bir\nsatır iki  ',
    });

    const stored = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: created.id },
      include: { messages: true },
    });

    // A subject is one line: the newline collapses to a space and the NUL is
    // gone.
    expect(stored.subject).toBe('Fatura hatası');
    // A body keeps the newlines somebody typed, loses the bell character, and
    // is stored verbatim otherwise — the markup is characters, and every
    // surface renders it as characters.
    expect(stored.messages[0]!.body).toBe('<script>alert(1)</script> satır bir\nsatır iki');
  });
});

describe('what reaches the logs', () => {
  it('never writes a subject, a message body or an address to stdout', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customerUser = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: 'log-leak-check@example.test',
    });
    const customer: Party = {
      userId: customerUser.id,
      cookie: await loginAs(ctx.prisma, customerUser.id),
    };

    const SUBJECT = 'Gizli-konu-log-sizintisi';
    const BODY = 'Gizli-govde-log-sizintisi';
    const REPLY = 'Gizli-operator-yaniti-log-sizintisi';

    // Everything the process writes while the exchange happens. Nest's logger
    // goes to stdout, so capturing both streams is the whole surface a log
    // aggregator would see.
    const captured: string[] = [];
    const streams = [process.stdout, process.stderr] as const;
    const originals = streams.map((stream) => stream.write.bind(stream));

    for (const stream of streams) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stream as any).write = (chunk: unknown, ...rest: unknown[]) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      };
    }

    try {
      const ticket = await openTicket(customer, { subject: SUBJECT, message: BODY });
      await request(ctx.server)
        .post(`/admin/support/tickets/${ticket.id}/messages`)
        .set('Cookie', admin.cookie)
        .send({ body: REPLY })
        .expect(201);
      await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);
      await request(ctx.server)
        .get(`/support/tickets/${ticket.id}`)
        .set('Cookie', customer.cookie)
        .expect(200);
      // A refusal too: the error paths are where a body most often ends up in a
      // log, attached to whatever went wrong.
      await request(ctx.server)
        .post(`/support/tickets/${ticket.id}/messages`)
        .set('Cookie', customer.cookie)
        .send({ body: '   ' })
        .expect(400);
    } finally {
      streams.forEach((stream, index) => {
        stream.write = originals[index]!;
      });
    }

    const log = captured.join('');
    for (const secret of [SUBJECT, BODY, REPLY, 'log-leak-check@example.test', customer.cookie]) {
      expect(log, `"${secret}" must not reach the logs`).not.toContain(secret);
    }
  });
});

describe('integrity', () => {
  it('binds every row to a real ticket, a real author and one owner', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await request(ctx.server)
      .post(`/admin/support/tickets/${ticket.id}/messages`)
      .set('Cookie', admin.cookie)
      .send({ body: 'Bakıyoruz.' })
      .expect(201);
    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);

    const stored = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { messages: true, statusChanges: true },
    });

    expect(stored.customerId).toBe(customer.userId);
    expect(stored.messages.map((message) => message.authorUserId).sort()).toEqual(
      [customer.userId, admin.userId].sort(),
    );
    expect(stored.messages.every((message) => message.ticketId === ticket.id)).toBe(true);
    expect(stored.statusChanges[0]!.changedById).toBe(admin.userId);

    // The foreign keys are RESTRICT, so an account with a ticket cannot be
    // deleted out from under it and a ticket cannot be orphaned.
    await expect(ctx.prisma.user.delete({ where: { id: customer.userId } })).rejects.toThrowError();
    await expect(
      ctx.prisma.supportTicket.delete({ where: { id: ticket.id } }),
    ).rejects.toThrowError();
  });

  it('refuses a message pointed at a ticket that does not exist', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);

    await request(ctx.server)
      .post('/support/tickets/nonexistent-id/messages')
      .set('Cookie', customer.cookie)
      .send({ body: 'Yok olan talebe mesaj.' })
      .expect(404);

    await request(ctx.server)
      .post('/admin/support/tickets/nonexistent-id/messages')
      .set('Cookie', admin.cookie)
      .send({ body: 'Yok olan talebe mesaj.' })
      .expect(404);

    await request(ctx.server)
      .post('/admin/support/tickets/nonexistent-id/status')
      .set('Cookie', admin.cookie)
      .send({ status: SupportTicketStatus.IN_PROGRESS })
      .expect(404);

    expect(await ctx.prisma.supportTicketMessage.count()).toBe(0);
  });

  it('keeps the activity mark consistent when two messages race', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    const before = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { lastActivityAt: true },
    });

    // Both sides write at the same moment. Whatever order the database settles
    // on, exactly two messages land and the ticket's activity mark is not left
    // behind either of them.
    await Promise.all([
      request(ctx.server)
        .post(`/support/tickets/${ticket.id}/messages`)
        .set('Cookie', customer.cookie)
        .send({ body: 'Müşteri yazıyor.' })
        .expect(201),
      request(ctx.server)
        .post(`/admin/support/tickets/${ticket.id}/messages`)
        .set('Cookie', admin.cookie)
        .send({ body: 'Operatör yazıyor.' })
        .expect(201),
    ]);

    const after = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { lastActivityAt: true },
    });
    const messages = await ctx.prisma.supportTicketMessage.findMany({
      where: { ticketId: ticket.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    expect(messages).toHaveLength(3);
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.lastActivityAt.getTime());
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
      messages.at(-1)!.createdAt.getTime(),
    );
  });
});
