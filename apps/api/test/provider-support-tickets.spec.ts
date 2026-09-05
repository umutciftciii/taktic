import {
  NotificationStatus,
  SupportTicketAuthorRole,
  SupportTicketRequesterRole,
  SupportTicketStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import { DEFAULT_SUPPORT_INBOX_EMAIL } from '../src/modules/support-tickets/support-inbox.config';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * The support desk, once it serves both sides of the marketplace.
 *
 * The claim under test is three sentences. **A hizmet veren opens, reads and
 * answers tickets of their own through the same routes a hizmet alan does.
 * Neither can reach the other's, and the refusal tells them nothing.** And
 * **the operator sees one queue holding both, can narrow it to either, and
 * every event still produces exactly the e-mails it owes.**
 *
 * `apps/api/test/support-tickets.spec.ts` still owns the rules that are the
 * same for everybody — the transition table, the text normalisation, the
 * closed-ticket refusals — and is not repeated here. What is here is only what
 * the second desk changed.
 *
 * Every fixture goes through the real endpoints, for the reason the older spec
 * gives: a ticket inserted by hand would prove something the product does not
 * do, and the whole point of `requesterRole` is that the create path writes it
 * from the session.
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
  delete process.env.SUPPORT_INBOX_EMAIL;
});

type Party = { userId: string; email: string; cookie: string };

async function signIn(role: UserRole, overrides: { name?: string } = {}): Promise<Party> {
  const user = await createUser(ctx.prisma, { role, name: overrides.name });
  return {
    userId: user.id,
    email: user.email as string,
    cookie: await loginAs(ctx.prisma, user.id),
  };
}

async function openTicket(party: Party, overrides: { subject?: string; message?: string } = {}) {
  const response = await request(ctx.server)
    .post('/support/tickets')
    .set('Cookie', party.cookie)
    .send({
      subject: overrides.subject ?? 'Teklif verirken kredi düştü ama teklif gitmedi',
      message: overrides.message ?? 'Kredim düştü, teklifim listede görünmüyor.',
    })
    .expect(201);

  return response.body as { id: string; status: SupportTicketStatus; requesterRole: string };
}

function reply(party: Party, ticketId: string, body: string) {
  return request(ctx.server)
    .post(`/support/tickets/${ticketId}/messages`)
    .set('Cookie', party.cookie)
    .send({ body });
}

function adminReply(admin: Party, ticketId: string, body: string) {
  return request(ctx.server)
    .post(`/admin/support/tickets/${ticketId}/messages`)
    .set('Cookie', admin.cookie)
    .send({ body });
}

function moveStatus(admin: Party, ticketId: string, status: SupportTicketStatus) {
  return request(ctx.server)
    .post(`/admin/support/tickets/${ticketId}/status`)
    .set('Cookie', admin.cookie)
    .send({ status });
}

function sentOf(template: NotificationMessage['template']): NotificationMessage[] {
  return ctx.notifications.ofTemplate(template);
}

function only(messages: NotificationMessage[]): NotificationMessage {
  expect(messages).toHaveLength(1);
  return messages[0] as NotificationMessage;
}

function supportLogs() {
  return ctx.prisma.notificationLog.findMany({
    where: { template: { startsWith: 'support-ticket-' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { template: true, dedupeKey: true, status: true, userId: true },
  });
}

describe('a hizmet veren and their own tickets', () => {
  it('opens one, finds it in their list, reads it and replies', async () => {
    const provider = await signIn(UserRole.PROVIDER);

    const created = await openTicket(provider, {
      subject: 'Kredi düştü, teklif gitmedi',
      message: 'Teklif verirken kredim düştü ama teklif listede yok.',
    });

    expect(created.status).toBe(SupportTicketStatus.OPEN);
    expect(created.requesterRole).toBe(SupportTicketRequesterRole.PROVIDER);

    const list = await request(ctx.server)
      .get('/support/tickets')
      .set('Cookie', provider.cookie)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id: created.id,
      subject: 'Kredi düştü, teklif gitmedi',
      requesterRole: SupportTicketRequesterRole.PROVIDER,
    });

    const detail = await request(ctx.server)
      .get(`/support/tickets/${created.id}`)
      .set('Cookie', provider.cookie)
      .expect(200);

    expect(detail.body.canReply).toBe(true);
    expect(detail.body.timeline).toHaveLength(1);
    expect(detail.body.timeline[0]).toMatchObject({
      kind: 'MESSAGE',
      authorRole: SupportTicketAuthorRole.PROVIDER,
      mine: true,
      body: 'Teklif verirken kredim düştü ama teklif listede yok.',
    });

    await reply(provider, created.id, 'Ekleme: teklif numarası TR-90412.').expect(201);

    const reread = await request(ctx.server)
      .get(`/support/tickets/${created.id}`)
      .set('Cookie', provider.cookie)
      .expect(200);

    expect(reread.body.timeline).toHaveLength(2);
    expect(reread.body.timeline[1]).toMatchObject({
      authorRole: SupportTicketAuthorRole.PROVIDER,
      mine: true,
    });
  });

  it('cannot name its own desk, its owner or its status when opening one', async () => {
    const provider = await signIn(UserRole.PROVIDER);
    const customer = await signIn(UserRole.CUSTOMER);

    // Every one of these is a field the create path takes from the session. The
    // DTO whitelist refuses the request outright rather than ignoring them,
    // which is the difference between "cannot" and "does not happen to".
    for (const forged of [
      { requesterId: customer.userId },
      { requesterRole: SupportTicketRequesterRole.CUSTOMER },
      { status: SupportTicketStatus.RESOLVED },
      { authorRole: SupportTicketAuthorRole.ADMIN },
    ]) {
      await request(ctx.server)
        .post('/support/tickets')
        .set('Cookie', provider.cookie)
        .send({ subject: 'Konu', message: 'Mesaj', ...forged })
        .expect(400);
    }

    expect(await ctx.prisma.supportTicket.count()).toBe(0);
  });

  it('sees the ticket it opened stay a hizmet veren ticket, whatever the account does later', async () => {
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);

    // The role snapshot is the ticket's, not the account's. Changing the
    // account's role is not something the product does, which is exactly why
    // this is worth pinning: the day it does, an old ticket must not migrate to
    // the other desk — and must not become reachable from the other desk's
    // list either.
    await ctx.prisma.user.update({
      where: { id: provider.userId },
      data: { role: UserRole.CUSTOMER },
    });

    const stored = await ctx.prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { requesterRole: true },
    });
    expect(stored.requesterRole).toBe(SupportTicketRequesterRole.PROVIDER);

    // And the account, now a hizmet alan, no longer reaches it: the ownership
    // scope carries the desk as well as the id.
    const list = await request(ctx.server)
      .get('/support/tickets')
      .set('Cookie', provider.cookie)
      .expect(200);
    expect(list.body).toHaveLength(0);

    await request(ctx.server)
      .get(`/support/tickets/${ticket.id}`)
      .set('Cookie', provider.cookie)
      .expect(404);
  });
});

describe('the operator, with two desks in one queue', () => {
  it('lists both, filters to either, and counts each honestly', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);

    const customerTicket = await openTicket(customer, { subject: 'Hizmet alan konusu' });
    const providerTicket = await openTicket(provider, { subject: 'Hizmet veren konusu' });

    const all = await request(ctx.server)
      .get('/admin/support/tickets')
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(all.body.total).toBe(2);
    expect(all.body.requesterRoleCounts).toEqual({ CUSTOMER: 1, PROVIDER: 1 });

    const byId = new Map<string, { requesterRole: string; requester: { id: string } }>(
      all.body.items.map((item: { id: string }) => [item.id, item]),
    );
    expect(byId.get(customerTicket.id)?.requesterRole).toBe(SupportTicketRequesterRole.CUSTOMER);
    expect(byId.get(providerTicket.id)?.requesterRole).toBe(SupportTicketRequesterRole.PROVIDER);
    expect(byId.get(providerTicket.id)?.requester.id).toBe(provider.userId);

    for (const [role, expected] of [
      [SupportTicketRequesterRole.PROVIDER, providerTicket.id],
      [SupportTicketRequesterRole.CUSTOMER, customerTicket.id],
    ] as const) {
      const filtered = await request(ctx.server)
        .get(`/admin/support/tickets?requesterRole=${role}`)
        .set('Cookie', admin.cookie)
        .expect(200);

      expect(filtered.body.total).toBe(1);
      expect(filtered.body.items.map((item: { id: string }) => item.id)).toEqual([expected]);
      // The status chips count the desk on screen, so the filter and the
      // numbers beside it describe the same list.
      expect(filtered.body.statusCounts.OPEN).toBe(1);
      // The desk chips keep counting both, so switching desks says how many
      // are on the other one rather than repeating the list already shown.
      expect(filtered.body.requesterRoleCounts).toEqual({ CUSTOMER: 1, PROVIDER: 1 });
    }
  });

  it('combines the desk filter with the status filter', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const customer = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);

    await openTicket(customer);
    const providerOpen = await openTicket(provider, { subject: 'Açık kalan' });
    const providerResolved = await openTicket(provider, { subject: 'Çözülen' });
    await moveStatus(admin, providerResolved.id, SupportTicketStatus.RESOLVED).expect(200);

    const filtered = await request(ctx.server)
      .get(`/admin/support/tickets?requesterRole=PROVIDER&status=OPEN`)
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(filtered.body.items.map((item: { id: string }) => item.id)).toEqual([providerOpen.id]);
    // Under `status=OPEN`, one open ticket per desk.
    expect(filtered.body.requesterRoleCounts).toEqual({ CUSTOMER: 1, PROVIDER: 1 });
  });

  it('refuses a desk this build does not have rather than listing everything', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);

    await request(ctx.server)
      .get('/admin/support/tickets?requesterRole=SUPER_ADMIN')
      .set('Cookie', admin.cookie)
      .expect(400);
  });

  it('answers a hizmet veren and walks the ticket to closed', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);

    await adminReply(admin, ticket.id, 'Krediniz iade edildi.').expect(201);
    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);
    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);

    const resolved = await request(ctx.server)
      .get(`/support/tickets/${ticket.id}`)
      .set('Cookie', provider.cookie)
      .expect(200);

    // The same terminal rules the hizmet alan desk has always had.
    expect(resolved.body.canReply).toBe(false);
    await reply(provider, ticket.id, 'Bir şey daha.').expect(409);

    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);
    await adminReply(admin, ticket.id, 'Kapalıya yazamam.').expect(409);
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(409);

    const closed = await request(ctx.server)
      .get(`/admin/support/tickets/${ticket.id}`)
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(closed.body.allowedTransitions).toEqual([]);
    expect(closed.body.requesterRole).toBe(SupportTicketRequesterRole.PROVIDER);
  });
});

describe('what a hizmet veren ticket puts in an inbox', () => {
  it('announces the opening to the support mailbox and to the hizmet veren, once each', async () => {
    const provider = await signIn(UserRole.PROVIDER, { name: 'Murat Şahin' });
    const ticket = await openTicket(provider, {
      subject: 'Kredi düştü',
      message: 'Teklifim gitmedi.',
    });

    const toSupport = only(sentOf('support-ticket-provider-new-for-support'));
    const toProvider = only(sentOf('support-ticket-provider-created'));

    expect(toSupport.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(toProvider.to).toBe(provider.email);

    // The operator's copy says who is waiting and which desk they are on.
    expect(toSupport.data).toMatchObject({
      requesterName: 'Murat Şahin',
      requesterEmail: provider.email,
      requesterRoleLabel: 'Hizmet veren',
      ticketReference: ticket.id,
    });

    // The hizmet alan's templates are not touched by a hizmet veren's ticket.
    expect(sentOf('support-ticket-created')).toHaveLength(0);
    expect(sentOf('support-ticket-new-for-support')).toHaveLength(0);

    const logs = await supportLogs();
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((log) => log.dedupeKey)).size).toBe(2);
    for (const log of logs) {
      expect(log.dedupeKey).toContain(ticket.id);
      expect(log.status).toBe(NotificationStatus.SENT);
    }
  });

  it('tells the support mailbox about a hizmet veren reply, and nobody else', async () => {
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);
    ctx.notifications.clear();

    await reply(provider, ticket.id, 'Ek bilgi.').expect(201);

    const toSupport = only(sentOf('support-ticket-provider-reply'));
    expect(toSupport.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    // Not to the provider: they do not need to be told what they just wrote.
    expect(ctx.notifications.sent.filter((sent) => sent.to === provider.email)).toHaveLength(0);
    expect(sentOf('support-ticket-customer-reply')).toHaveLength(0);
  });

  it('tells the hizmet veren about an answer and a status change, and never who wrote it', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN, { name: 'Operatör Ayşe' });
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);
    ctx.notifications.clear();

    await adminReply(admin, ticket.id, 'Krediniz iade edildi.').expect(201);
    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);

    const answer = only(sentOf('support-ticket-provider-admin-reply'));
    const moved = only(sentOf('support-ticket-provider-status-changed'));

    for (const message of [answer, moved]) {
      expect(message.to).toBe(provider.email);
      // The Reply-To the hizmet alan's messages have always carried.
      expect(message.replyTo).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);

      // Nothing about the operator reaches the payload at all — there is no
      // field on it their identity could arrive in.
      const serialised = JSON.stringify(message.data ?? {});
      expect(serialised).not.toContain('Operatör Ayşe');
      expect(serialised).not.toContain(admin.email);
      expect(serialised).not.toContain(admin.userId);
    }

    // And the hizmet alan's templates stayed out of it.
    expect(sentOf('support-ticket-admin-reply')).toHaveLength(0);
    expect(sentOf('support-ticket-status-changed')).toHaveLength(0);
  });

  it('produces one e-mail per event, and a replay produces none', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);
    await reply(provider, ticket.id, 'Ek bilgi.').expect(201);
    await adminReply(admin, ticket.id, 'Bakıyoruz.').expect(201);
    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);

    const first = await supportLogs();
    // Five events, five messages: two for the opening, one for the reply, one
    // for the answer, one for the move.
    expect(first).toHaveLength(5);
    expect(first.map((log) => log.template).sort()).toEqual(
      [
        'support-ticket-provider-admin-reply',
        'support-ticket-provider-created',
        'support-ticket-provider-new-for-support',
        'support-ticket-provider-reply',
        'support-ticket-provider-status-changed',
      ].sort(),
    );

    const before = ctx.notifications.sent.length;

    // Replaying every event: the unique index on (template, dedupeKey) is what
    // makes the second attempt a no-op, and it is the same index the hizmet
    // alan desk has always relied on.
    const mail = ctx.app.get(
      (await import('../src/modules/notifications/transactional-mail.service'))
        .TransactionalMailService,
    );
    const message = await ctx.prisma.supportTicketMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, authorRole: SupportTicketAuthorRole.PROVIDER, body: 'Ek bilgi.' },
      select: { id: true },
    });
    const answer = await ctx.prisma.supportTicketMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, authorRole: SupportTicketAuthorRole.ADMIN },
      select: { id: true },
    });
    const change = await ctx.prisma.supportTicketStatusChange.findFirstOrThrow({
      where: { ticketId: ticket.id },
      select: { id: true },
    });

    await mail.sendSupportTicketOpened(ticket.id);
    await mail.sendSupportTicketRequesterMessage(message.id);
    await mail.sendSupportTicketAdminMessage(answer.id);
    await mail.sendSupportTicketStatusChanged(change.id);

    expect(await supportLogs()).toHaveLength(5);
    expect(ctx.notifications.sent).toHaveLength(before);
  });

  it('never files an operator answer as a hizmet veren reply', async () => {
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(provider);
    await adminReply(admin, ticket.id, 'Bakıyoruz.').expect(201);
    ctx.notifications.clear();

    const mail = ctx.app.get(
      (await import('../src/modules/notifications/transactional-mail.service'))
        .TransactionalMailService,
    );
    const answer = await ctx.prisma.supportTicketMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, authorRole: SupportTicketAuthorRole.ADMIN },
      select: { id: true },
    });

    // Pointing the requester-reply method at an operator's message: the author
    // role does not match the ticket's desk, so nothing is sent rather than the
    // support mailbox being told the hizmet veren wrote what an operator wrote.
    await mail.sendSupportTicketRequesterMessage(answer.id);

    expect(sentOf('support-ticket-provider-reply')).toHaveLength(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});

describe('the column the migration left behind', () => {
  /**
   * The desk has no database default.
   *
   * The migration added `requesterRole` *with* a default so the rows that
   * already existed were filled in as CUSTOMER — which is what every one of
   * them was — and then dropped it. This is the assertion that the second half
   * happened: a create path that forgot to say which desk a ticket belongs to
   * has to fail loudly rather than quietly filing a hizmet veren's ticket as a
   * hizmet alan's.
   */
  it('refuses a ticket that does not say which desk it is on', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO "SupportTicket" ("id", "requesterId", "subject", "updatedAt")
         VALUES ('desk-less-ticket', $1, 'Masasız talep', now())`,
        customer.userId,
      ),
    ).rejects.toThrowError();

    expect(await ctx.prisma.supportTicket.count()).toBe(0);
  });
});
