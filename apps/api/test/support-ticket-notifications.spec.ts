import { NotificationStatus, SupportTicketStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import { DEFAULT_SUPPORT_INBOX_EMAIL } from '../src/modules/support-tickets/support-inbox.config';
import { createTestApp, createUser, loginAs, resetDatabase, type TestContext } from './harness';

/**
 * Who hears about a support ticket, and exactly how often.
 *
 * The claim under test is one sentence: **every support event produces the
 * messages it owes and not one more, and it produces them only once the
 * transaction that caused it has committed.** Everything below either
 * establishes that or attacks it — a repeated dispatch, a rolled-back
 * transaction, a closed ticket, a stranger's ticket, an unauthorised caller.
 *
 * The audit table is the subject of most assertions rather than the recording
 * transport, because NotificationLog is what actually enforces "once": the
 * unique index on (template, dedupeKey) is the guarantee, and a test that only
 * counted what the transport saw would pass just as happily with no key at all.
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
  vi.restoreAllMocks();
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

async function openTicket(customer: Party, overrides: { subject?: string; message?: string } = {}) {
  const response = await request(ctx.server)
    .post('/support/tickets')
    .set('Cookie', customer.cookie)
    .send({
      subject: overrides.subject ?? 'Faturam ulaşmadı',
      message: overrides.message ?? 'Geçen haftaki talebimin faturası elime geçmedi.',
    })
    .expect(201);

  return response.body as { id: string };
}

function customerReply(customer: Party, ticketId: string, body: string) {
  return request(ctx.server)
    .post(`/support/tickets/${ticketId}/messages`)
    .set('Cookie', customer.cookie)
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

/** Every audit row this build wrote for a support message, oldest first. */
function supportLogs() {
  return ctx.prisma.notificationLog.findMany({
    where: { template: { startsWith: 'support-ticket-' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      template: true,
      maskedRecipient: true,
      dedupeKey: true,
      status: true,
      userId: true,
    },
  });
}

function sentOf(template: NotificationMessage['template']): NotificationMessage[] {
  return ctx.notifications.ofTemplate(template);
}

/** The one message a case expects, or a failure that says which case is wrong. */
function only(messages: NotificationMessage[]): NotificationMessage {
  expect(messages).toHaveLength(1);
  return messages[0] as NotificationMessage;
}

const mail = () => ctx.app.get(TransactionalMailService);

describe('a customer opens a ticket', () => {
  it('writes exactly two notifications: one to support, one to the customer', async () => {
    const customer = await signIn(UserRole.CUSTOMER, { name: 'Deniz Yılmaz' });

    const ticket = await openTicket(customer, {
      subject: 'Faturam ulaşmadı',
      message: 'Geçen haftaki talebimin faturası elime geçmedi.',
    });

    const logs = await supportLogs();
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.template).sort()).toEqual([
      'support-ticket-created',
      'support-ticket-new-for-support',
    ]);
    // Two templates, two keys. The same event produces both, and neither can
    // suppress the other.
    expect(new Set(logs.map((log) => log.dedupeKey)).size).toBe(2);
    for (const log of logs) {
      expect(log.dedupeKey).toContain(ticket.id);
      expect(log.status).toBe(NotificationStatus.SENT);
    }

    const toCustomer = only(sentOf('support-ticket-created'));
    const toSupport = only(sentOf('support-ticket-new-for-support'));

    expect(toCustomer.to).toBe(customer.email);
    expect(toSupport.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
  });

  it('carries the ticket, the subject and the opening message to both sides', async () => {
    const customer = await signIn(UserRole.CUSTOMER, { name: 'Deniz Yılmaz' });
    const ticket = await openTicket(customer, {
      subject: 'Faturam ulaşmadı',
      message: 'Geçen haftaki talebimin faturası elime geçmedi.',
    });

    const toCustomer = only(sentOf('support-ticket-created'));
    expect(toCustomer.data).toMatchObject({
      fullName: 'Deniz Yılmaz',
      ticketReference: ticket.id,
      ticketSubject: 'Faturam ulaşmadı',
      messageExcerpt: 'Geçen haftaki talebimin faturası elime geçmedi.',
      status: SupportTicketStatus.OPEN,
    });
    expect(toCustomer.data?.ticketUrl).toContain(`/destek/${ticket.id}`);

    const toSupport = only(sentOf('support-ticket-new-for-support'));
    // The operator's copy names the person waiting; the queue screen shows the
    // same two fields.
    expect(toSupport.data).toMatchObject({
      requesterName: 'Deniz Yılmaz',
      requesterEmail: customer.email,
      // And which desk, so a shared mailbox can be triaged without opening it.
      requesterRoleLabel: 'Hizmet alan',
      ticketReference: ticket.id,
    });
    expect(toSupport.data?.ticketUrl).toContain(`/support/${ticket.id}`);
  });

  it('answers the customer to the support mailbox and the operator to nowhere in particular', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    await openTicket(customer);

    expect(only(sentOf('support-ticket-created')).replyTo).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    // The operator's own copy already comes from and goes to the support
    // mailbox; a Reply-To pointing it back at itself says nothing.
    expect(only(sentOf('support-ticket-new-for-support')).replyTo).toBeUndefined();
  });

  it('announces the ticket to the configured mailbox when there is one', async () => {
    process.env.SUPPORT_INBOX_EMAIL = 'yardim@partner.example.org';
    const customer = await signIn(UserRole.CUSTOMER);
    await openTicket(customer);

    expect(only(sentOf('support-ticket-new-for-support')).to).toBe('yardim@partner.example.org');
    // Both directions follow the one setting.
    expect(only(sentOf('support-ticket-created')).replyTo).toBe('yardim@partner.example.org');
  });

  it('produces no second pair when the same dispatch runs again', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    // A retried HTTP request, a second API instance, a Serializable retry that
    // replayed the handler: all of them reach the dispatcher a second time with
    // the same ticket, and the unique index is what answers.
    await mail().sendSupportTicketOpened(ticket.id);
    await mail().sendSupportTicketOpened(ticket.id);

    expect(await supportLogs()).toHaveLength(2);
    expect(sentOf('support-ticket-created')).toHaveLength(1);
    expect(sentOf('support-ticket-new-for-support')).toHaveLength(1);
  });

  it('gives two tickets from one customer two notifications each', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    const first = await openTicket(customer, { subject: 'Birinci konu' });
    const second = await openTicket(customer, { subject: 'İkinci konu' });

    expect(first.id).not.toBe(second.id);
    expect(await supportLogs()).toHaveLength(4);
  });
});

describe('a customer writes on their ticket', () => {
  it('tells support and nobody else', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await customerReply(customer, ticket.id, 'Ek olarak talep numaram TR-1234.').expect(201);

    const logs = await supportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.template).toBe('support-ticket-customer-reply');

    const message = only(sentOf('support-ticket-customer-reply'));
    expect(message.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(message.data?.messageExcerpt).toBe('Ek olarak talep numaram TR-1234.');
    // The customer already knows what they just wrote.
    expect(sentOf('support-ticket-admin-reply')).toHaveLength(0);
    expect(sentOf('support-ticket-created')).toHaveLength(0);
  });

  it('keys the notification on the message, so a replay adds nothing', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);
    await customerReply(customer, ticket.id, 'Ek bilgi.').expect(201);

    const written = await ctx.prisma.supportTicketMessage.findFirst({
      where: { ticketId: ticket.id, authorRole: 'CUSTOMER', body: 'Ek bilgi.' },
      select: { id: true },
    });

    await mail().sendSupportTicketRequesterMessage(written?.id as string);

    expect(sentOf('support-ticket-customer-reply')).toHaveLength(1);
    const logs = (await supportLogs()).filter(
      (log) => log.template === 'support-ticket-customer-reply',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.dedupeKey).toContain(written?.id as string);
  });

  it('sends a second notification for a second message', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(customer);

    await customerReply(customer, ticket.id, 'Birinci ek.').expect(201);
    await customerReply(customer, ticket.id, 'İkinci ek.').expect(201);

    expect(sentOf('support-ticket-customer-reply')).toHaveLength(2);
  });
});

describe('an operator writes on a ticket', () => {
  it('tells the customer and nobody else', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await adminReply(admin, ticket.id, 'Faturanızı yeniden gönderdik.').expect(201);

    const logs = await supportLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.template).toBe('support-ticket-admin-reply');
    expect(logs[0]?.userId).toBe(customer.userId);

    const message = only(sentOf('support-ticket-admin-reply'));
    expect(message.to).toBe(customer.email);
    expect(message.replyTo).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(sentOf('support-ticket-customer-reply')).toHaveLength(0);
  });

  it('says nothing about the operator who wrote it', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN, { name: 'Operatör Ayşe' });
    const ticket = await openTicket(customer);

    await adminReply(admin, ticket.id, 'Faturanızı yeniden gönderdik.').expect(201);

    const payload = JSON.stringify(only(sentOf('support-ticket-admin-reply')));
    expect(payload).not.toContain(admin.email);
    expect(payload).not.toContain('Operatör Ayşe');
    expect(payload).not.toContain(admin.userId);
  });

  it('adds no second notification when the same dispatch runs again', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    await adminReply(admin, ticket.id, 'Yanıtımız.').expect(201);

    const written = await ctx.prisma.supportTicketMessage.findFirst({
      where: { ticketId: ticket.id, authorRole: 'ADMIN' },
      select: { id: true },
    });

    await mail().sendSupportTicketAdminMessage(written?.id as string);
    await mail().sendSupportTicketAdminMessage(written?.id as string);

    expect(sentOf('support-ticket-admin-reply')).toHaveLength(1);
  });
});

describe('an operator moves the status', () => {
  it('tells the customer once per legal transition, and names both ends', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);
    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);
    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);

    const sent = sentOf('support-ticket-status-changed');
    expect(sent).toHaveLength(3);
    expect(sent.map((message) => message.data?.status)).toEqual([
      SupportTicketStatus.IN_PROGRESS,
      SupportTicketStatus.RESOLVED,
      SupportTicketStatus.CLOSED,
    ]);
    expect(sent.map((message) => message.data?.fromStatus)).toEqual([
      SupportTicketStatus.OPEN,
      SupportTicketStatus.IN_PROGRESS,
      SupportTicketStatus.RESOLVED,
    ]);
    for (const message of sent) {
      expect(message.to).toBe(customer.email);
      expect(message.replyTo).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    }

    const logs = await supportLogs();
    expect(logs).toHaveLength(3);
    // One key per recorded change, so three changes are three keys.
    expect(new Set(logs.map((log) => log.dedupeKey)).size).toBe(3);
  });

  it('sends nothing for a transition the table refuses', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    // OPEN cannot go straight to CLOSED, and no status may move to itself.
    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(409);
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(409);

    expect(await supportLogs()).toHaveLength(0);
    expect(sentOf('support-ticket-status-changed')).toHaveLength(0);
  });

  it('adds no second notification when the same change is dispatched again', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    await moveStatus(admin, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(200);

    const change = await ctx.prisma.supportTicketStatusChange.findFirst({
      where: { ticketId: ticket.id },
      select: { id: true },
    });

    await mail().sendSupportTicketStatusChanged(change?.id as string);
    await mail().sendSupportTicketStatusChanged(change?.id as string);

    expect(sentOf('support-ticket-status-changed')).toHaveLength(1);
  });
});

describe('what produces no notification at all', () => {
  it('writes nothing when the transaction that would have caused it rolls back', async () => {
    const customer = await signIn(UserRole.CUSTOMER);

    // The real transaction runs and is then abandoned, exactly as a constraint
    // violation or a Serializable conflict would abandon it. Nothing it wrote
    // survives — and the notification, which happens after the commit point,
    // never happens at all.
    type InteractiveTransaction = (handler: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    const original = ctx.prisma.$transaction.bind(ctx.prisma) as InteractiveTransaction;

    vi.spyOn(ctx.prisma, '$transaction').mockImplementationOnce((((
      handler: (tx: unknown) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        await handler(tx);
        throw new Error('rolled back on purpose');
      })) as unknown) as typeof ctx.prisma.$transaction);

    await request(ctx.server)
      .post('/support/tickets')
      .set('Cookie', customer.cookie)
      .send({ subject: 'Faturam ulaşmadı', message: 'Fatura elime geçmedi.' })
      .expect(500);

    expect(await ctx.prisma.supportTicket.count()).toBe(0);
    expect(await ctx.prisma.supportTicketMessage.count()).toBe(0);
    expect(await supportLogs()).toHaveLength(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('sends nothing on a closed ticket, from either side', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);
    await moveStatus(admin, ticket.id, SupportTicketStatus.CLOSED).expect(200);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await customerReply(customer, ticket.id, 'Bir şey daha var.').expect(409);
    await adminReply(admin, ticket.id, 'Ek bilgi.').expect(409);
    await moveStatus(admin, ticket.id, SupportTicketStatus.OPEN).expect(409);

    expect(await supportLogs()).toHaveLength(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('sends nothing for a customer writing on a resolved ticket', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    await moveStatus(admin, ticket.id, SupportTicketStatus.RESOLVED).expect(200);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await customerReply(customer, ticket.id, 'Bir şey daha var.').expect(409);

    expect(await supportLogs()).toHaveLength(0);
  });

  it("sends nothing when a stranger writes on somebody else's ticket", async () => {
    const owner = await signIn(UserRole.CUSTOMER);
    const stranger = await signIn(UserRole.CUSTOMER);
    const ticket = await openTicket(owner);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    await customerReply(stranger, ticket.id, 'Ben de yazabiliyorum.').expect(404);

    expect(await supportLogs()).toHaveLength(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('sends nothing for an unauthorised caller on any of the four events', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    const provider = await signIn(UserRole.PROVIDER);
    const ticket = await openTicket(customer);
    ctx.notifications.clear();
    await ctx.prisma.notificationLog.deleteMany({});

    // Anonymous on the requester routes.
    await request(ctx.server)
      .post('/support/tickets')
      .send({ subject: 'Konu', message: 'Mesaj' })
      .expect(401);
    await request(ctx.server)
      .post(`/support/tickets/${ticket.id}/messages`)
      .send({ body: 'Anonim mesaj' })
      .expect(401);
    // A hizmet veren may open tickets of their own now, but not write into a
    // hizmet alan's — and a refusal that produces an e-mail would tell the
    // support mailbox about a message nobody was allowed to send.
    await customerReply(provider, ticket.id, 'Bu talep benim değil.').expect(404);
    // And neither marketplace role reaches the operator's routes at all.
    await adminReply(provider, ticket.id, 'Yetkim yok.').expect(403);
    await moveStatus(provider, ticket.id, SupportTicketStatus.IN_PROGRESS).expect(403);

    expect(await supportLogs()).toHaveLength(0);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('records a failed transport without losing the ticket', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    ctx.notifications.failNextSend = true;

    const ticket = await openTicket(customer);

    // The business transaction committed regardless: a broken mail transport
    // cannot un-open a ticket a customer has been shown.
    expect(await ctx.prisma.supportTicket.count({ where: { id: ticket.id } })).toBe(1);
    const logs = await supportLogs();
    expect(logs).toHaveLength(2);
    expect(logs.some((log) => log.status === NotificationStatus.FAILED)).toBe(true);
  });
});

describe('an operator retrying a failed support notification', () => {
  async function adminCookie() {
    const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
    return loginAs(ctx.prisma, admin.id);
  }

  it('rebuilds the message from live data, on the same row and under the same key', async () => {
    const customer = await signIn(UserRole.CUSTOMER, { name: 'Deniz Yılmaz' });
    const admin = await signIn(UserRole.SUPER_ADMIN);
    const ticket = await openTicket(customer);
    await adminReply(admin, ticket.id, 'Faturanızı yeniden gönderdik.').expect(201);

    const written = await ctx.prisma.supportTicketMessage.findFirstOrThrow({
      where: { ticketId: ticket.id, authorRole: 'ADMIN' },
      select: { id: true },
    });
    const row = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'support-ticket-admin-reply' },
    });
    // Put the row back into the state a broken transport would have left it in.
    await ctx.prisma.notificationLog.update({
      where: { id: row.id },
      data: { status: NotificationStatus.FAILED, failedAt: new Date(), errorCode: 'TIMEOUT' },
    });
    ctx.notifications.clear();

    await request(ctx.server)
      .post(`/notification-logs/${row.id}/retry`)
      .set('Cookie', await adminCookie())
      .expect(200);

    const resent = only(sentOf('support-ticket-admin-reply'));
    expect(resent.to).toBe(customer.email);
    // A re-sent answer still has to be answerable.
    expect(resent.replyTo).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(resent.data?.ticketReference).toBe(ticket.id);
    expect(resent.data?.messageExcerpt).toBe('Faturanızı yeniden gönderdik.');

    // No second notification identity: one row, still keyed on the message.
    const rows = await supportLogs();
    expect(rows.filter((log) => log.template === 'support-ticket-admin-reply')).toHaveLength(1);
    expect(
      rows.find((log) => log.template === 'support-ticket-admin-reply')?.dedupeKey,
    ).toBe(`support-ticket-admin-reply:${written.id}`);
  });

  it('rebuilds the operator copy to the support mailbox, not to the customer', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    ctx.notifications.failNextSend = true;
    const ticket = await openTicket(customer);

    const row = await ctx.prisma.notificationLog.findFirstOrThrow({
      where: { template: 'support-ticket-new-for-support' },
    });
    expect(row.status).toBe(NotificationStatus.FAILED);
    ctx.notifications.clear();

    await request(ctx.server)
      .post(`/notification-logs/${row.id}/retry`)
      .set('Cookie', await adminCookie())
      .expect(200);

    const resent = only(sentOf('support-ticket-new-for-support'));
    expect(resent.to).toBe(DEFAULT_SUPPORT_INBOX_EMAIL);
    expect(resent.data?.ticketReference).toBe(ticket.id);
  });
});

describe('what an audit row is allowed to remember', () => {
  it('stores a masked recipient and no ticket content', async () => {
    const customer = await signIn(UserRole.CUSTOMER);
    await openTicket(customer, {
      subject: 'Faturam ulaşmadı',
      message: 'Geçen haftaki talebimin faturası elime geçmedi.',
    });

    for (const log of await supportLogs()) {
      expect(log.maskedRecipient).toContain('***');
      expect(JSON.stringify(log)).not.toContain('Faturam ulaşmadı');
      expect(JSON.stringify(log)).not.toContain('faturası elime geçmedi');
      expect(JSON.stringify(log)).not.toContain(customer.email);
    }
  });
});
