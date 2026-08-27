import {
  NotificationChannel,
  NotificationStatus,
  ProviderStatus,
  UserRole,
} from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectProviderMessageId } from '../src/modules/notification-logs/notification-log.projection';
import {
  createApprovedRequest,
  createCategory,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

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

type SeedOverrides = {
  channel?: NotificationChannel;
  template?: string;
  maskedRecipient?: string;
  status?: NotificationStatus;
  errorCode?: string | null;
  providerMessageId?: string | null;
  requestId?: string | null;
  userId?: string | null;
  createdAt?: Date;
  sentAt?: Date | null;
  failedAt?: Date | null;
};

let seedCounter = 0;

/**
 * Writes an audit row directly.
 *
 * The dispatcher's own behaviour is covered by the flows that use it; these
 * cases are about what the read endpoint does with a row once it exists, so the
 * fixture states the exact shape each case needs.
 */
async function seedLog(overrides: SeedOverrides = {}) {
  seedCounter += 1;

  return ctx.prisma.notificationLog.create({
    data: {
      channel: overrides.channel ?? NotificationChannel.EMAIL,
      template: overrides.template ?? 'customer-activation',
      maskedRecipient: overrides.maskedRecipient ?? `u${'*'.repeat(4)}@example.test`,
      status: overrides.status ?? NotificationStatus.SENT,
      errorCode: overrides.errorCode ?? null,
      providerMessageId: overrides.providerMessageId ?? null,
      requestId: overrides.requestId ?? null,
      userId: overrides.userId ?? null,
      createdAt: overrides.createdAt ?? new Date(Date.now() - seedCounter * 60_000),
      sentAt: overrides.sentAt === undefined ? new Date() : overrides.sentAt,
      failedAt: overrides.failedAt ?? null,
    },
  });
}

async function adminCookie() {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

function listUrl(query = '') {
  return query ? `/notification-logs?${query}` : '/notification-logs';
}

describe('notification log — who may read it', () => {
  it('refuses anonymous callers with 401', async () => {
    await seedLog();
    await request(ctx.server).get(listUrl()).expect(401);
  });

  it('refuses a customer and a provider with 403', async () => {
    const log = await seedLog();

    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    await request(ctx.server).get(listUrl()).set('Cookie', customerCookie).expect(403);
    await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', customerCookie)
      .expect(403);

    const providerUser = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    await createProviderProfile(ctx.prisma, {
      userId: providerUser.id,
      status: ProviderStatus.APPROVED,
    });
    const providerCookie = await loginAs(ctx.prisma, providerUser.id);
    await request(ctx.server).get(listUrl()).set('Cookie', providerCookie).expect(403);
    await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', providerCookie)
      .expect(403);
  });

  it('lets SUPER_ADMIN read the list and a single record', async () => {
    const log = await seedLog();
    const cookie = await adminCookie();

    const list = await request(ctx.server).get(listUrl()).set('Cookie', cookie).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(log.id);

    const detail = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.id).toBe(log.id);

    await request(ctx.server)
      .get('/notification-logs/no-such-log')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('reads without writing: no row is created, changed or removed', async () => {
    const log = await seedLog({ status: NotificationStatus.PENDING, sentAt: null });
    const before = await ctx.prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    const cookie = await adminCookie();

    await request(ctx.server).get(listUrl()).set('Cookie', cookie).expect(200);
    await request(ctx.server).get(`/notification-logs/${log.id}`).set('Cookie', cookie).expect(200);

    expect(await ctx.prisma.notificationLog.count()).toBe(1);
    const after = await ctx.prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after).toEqual(before);
  });
});

describe('notification log — filters, ordering and pagination', () => {
  it('filters by status, channel and template', async () => {
    const cookie = await adminCookie();
    const sent = await seedLog({ status: NotificationStatus.SENT });
    const failed = await seedLog({
      status: NotificationStatus.FAILED,
      channel: NotificationChannel.SMS,
      template: 'phone-verification-code',
      errorCode: 'TIMEOUT',
      sentAt: null,
      failedAt: new Date(),
    });
    const pending = await seedLog({
      status: NotificationStatus.PENDING,
      template: 'request-expiring',
      sentAt: null,
    });

    const byStatus = await request(ctx.server)
      .get(listUrl('status=FAILED'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(byStatus.body.items)).toEqual([failed.id]);

    const byChannel = await request(ctx.server)
      .get(listUrl('channel=SMS'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(byChannel.body.items)).toEqual([failed.id]);

    const byTemplate = await request(ctx.server)
      .get(listUrl('template=request-expiring'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(byTemplate.body.items)).toEqual([pending.id]);

    const combined = await request(ctx.server)
      .get(listUrl('status=SENT&channel=EMAIL'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(combined.body.items)).toEqual([sent.id]);
  });

  it('filters by requestId and userId', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });

    const linked = await seedLog({ requestId: serviceRequest.id, userId: customer.id });
    await seedLog();

    const byRequest = await request(ctx.server)
      .get(listUrl(`requestId=${serviceRequest.id}`))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(byRequest.body.items)).toEqual([linked.id]);

    const byUser = await request(ctx.server)
      .get(listUrl(`userId=${customer.id}`))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(byUser.body.items)).toEqual([linked.id]);
  });

  it('filters by created-at range', async () => {
    const cookie = await adminCookie();
    const old = await seedLog({ createdAt: new Date('2026-01-10T09:00:00.000Z') });
    const recent = await seedLog({ createdAt: new Date('2026-03-10T09:00:00.000Z') });

    const from = await request(ctx.server)
      .get(listUrl('from=2026-02-01T00:00:00.000Z'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(from.body.items)).toEqual([recent.id]);

    const to = await request(ctx.server)
      .get(listUrl('to=2026-02-01T00:00:00.000Z'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(to.body.items)).toEqual([old.id]);

    const window = await request(ctx.server)
      .get(listUrl('from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z'))
      .set('Cookie', cookie)
      .expect(200);
    expect(ids(window.body.items)).toEqual([recent.id, old.id]);

    await request(ctx.server)
      .get(listUrl('from=2026-12-31T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'))
      .set('Cookie', cookie)
      .expect(400);
  });

  it('returns the newest record first', async () => {
    const cookie = await adminCookie();
    const oldest = await seedLog({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newest = await seedLog({ createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const middle = await seedLog({ createdAt: new Date('2026-03-01T00:00:00.000Z') });

    const response = await request(ctx.server).get(listUrl()).set('Cookie', cookie).expect(200);
    expect(ids(response.body.items)).toEqual([newest.id, middle.id, oldest.id]);
  });

  it('keeps the pagination metadata consistent across pages', async () => {
    const cookie = await adminCookie();
    for (let index = 0; index < 5; index += 1) {
      await seedLog({ createdAt: new Date(Date.UTC(2026, 0, index + 1)) });
    }

    const first = await request(ctx.server)
      .get(listUrl('page=1&pageSize=2'))
      .set('Cookie', cookie)
      .expect(200);
    expect(first.body.total).toBe(5);
    expect(first.body.page).toBe(1);
    expect(first.body.pageSize).toBe(2);
    expect(first.body.hasNextPage).toBe(true);
    expect(first.body.items).toHaveLength(2);

    const last = await request(ctx.server)
      .get(listUrl('page=3&pageSize=2'))
      .set('Cookie', cookie)
      .expect(200);
    expect(last.body.hasNextPage).toBe(false);
    expect(last.body.items).toHaveLength(1);

    // Every page holds distinct rows, and together they cover the whole set.
    const second = await request(ctx.server)
      .get(listUrl('page=2&pageSize=2'))
      .set('Cookie', cookie)
      .expect(200);
    const seen = [...ids(first.body.items), ...ids(second.body.items), ...ids(last.body.items)];
    expect(new Set(seen).size).toBe(5);

    const beyond = await request(ctx.server)
      .get(listUrl('page=9&pageSize=2'))
      .set('Cookie', cookie)
      .expect(200);
    expect(beyond.body.items).toEqual([]);
    expect(beyond.body.total).toBe(5);
    expect(beyond.body.hasNextPage).toBe(false);
  });

  it('refuses filter values outside the enums', async () => {
    const cookie = await adminCookie();

    await request(ctx.server).get(listUrl('status=DELIVERED')).set('Cookie', cookie).expect(400);
    await request(ctx.server).get(listUrl('channel=PUSH')).set('Cookie', cookie).expect(400);
    await request(ctx.server).get(listUrl('page=0')).set('Cookie', cookie).expect(400);
    await request(ctx.server).get(listUrl('from=not-a-date')).set('Cookie', cookie).expect(400);
  });
});

describe('notification log — what the payload may contain', () => {
  it('exposes only the safe allow-list', async () => {
    const cookie = await adminCookie();
    const log = await seedLog({ providerMessageId: 'outbox-2f1c9d8e-0a11-4bd5-9f3c-77a1b2c3d4e5' });

    const response = await request(ctx.server)
      .get(`/notification-logs/${log.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        // Delivery bookkeeping: how many times this one message was attempted
        // and when the latest attempt was claimed. A count and a timestamp —
        // neither says anything about what the message contained.
        'attemptCount',
        'lastAttemptAt',
        'channel',
        'createdAt',
        'errorCode',
        'errorLabel',
        'failedAt',
        'id',
        'maskedRecipient',
        // The provider application a message was about. An id and nothing
        // else — the relation is deliberately never loaded, so no contact
        // detail can arrive through it.
        'providerId',
        'providerMessageId',
        'providerMessageIdRedacted',
        'requestId',
        // Whether this row may be re-sent, and why not. Computed from the row
        // itself; the dedupe key it is computed from stays inside the API.
        'retryable',
        'retryBlock',
        'retryBlockLabel',
        'sentAt',
        'status',
        'template',
        'userId',
      ].sort(),
    );
  });

  it('carries no recipient, code, token, URL or body, on either endpoint', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, {
      role: UserRole.CUSTOMER,
      email: 'gizli.musteri@example.test',
      phone: '05559998877',
    });
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
      customerEmail: 'gizli.talep@example.test',
    });
    const log = await seedLog({
      channel: NotificationChannel.SMS,
      template: 'phone-verification-code',
      maskedRecipient: '+90 ******* 77',
      requestId: serviceRequest.id,
      userId: customer.id,
    });

    for (const url of [listUrl(), `/notification-logs/${log.id}`]) {
      const response = await request(ctx.server).get(url).set('Cookie', cookie).expect(200);
      const body = JSON.stringify(response.body);

      // The customer's real contact details, in every form they exist in.
      expect(body).not.toContain('gizli.musteri@example.test');
      expect(body).not.toContain('gizli.talep@example.test');
      expect(body).not.toContain('05559998877');
      // Field names that would signal a payload leak if they ever appeared.
      expect(body).not.toContain('"code"');
      expect(body).not.toContain('"to"');
      expect(body).not.toContain('actionUrl');
      expect(body).not.toContain('subject');
      expect(body).not.toContain('"body"');
      expect(body).not.toContain('token');
      expect(body).not.toContain('http://');
      expect(body).not.toContain('https://');
      // The mask itself survives — it is the point of the screen.
      expect(body).toContain('+90 ******* 77');
    }
  });

  it('reports a safe label for every failure class and never the raw error', async () => {
    const cookie = await adminCookie();
    const expected: Record<string, string> = {
      TRANSPORT_UNAVAILABLE: 'Taşıma servisi kullanılamıyor',
      REJECTED: 'Alıcı reddedildi',
      TIMEOUT: 'Zaman aşımı',
      INVALID_RECIPIENT: 'Geçersiz alıcı',
      UNKNOWN: 'Bilinmeyen hata',
    };

    for (const [code, label] of Object.entries(expected)) {
      const log = await seedLog({
        status: NotificationStatus.FAILED,
        errorCode: code,
        sentAt: null,
        failedAt: new Date(),
      });

      const response = await request(ctx.server)
        .get(`/notification-logs/${log.id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.errorCode).toBe(code);
      expect(response.body.errorLabel).toBe(label);
    }

    // A row written outside the known set — an older build, or a hand-edited
    // row — is normalised rather than echoed back to the operator.
    const legacy = await seedLog({
      status: NotificationStatus.FAILED,
      errorCode: 'SMTP 550 5.1.1 <someone@example.test>: recipient rejected',
      sentAt: null,
      failedAt: new Date(),
    });
    const response = await request(ctx.server)
      .get(`/notification-logs/${legacy.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.errorCode).toBe('UNKNOWN');
    expect(response.body.errorLabel).toBe('Bilinmeyen hata');
    expect(JSON.stringify(response.body)).not.toContain('someone@example.test');

    const sent = await seedLog();
    const sentResponse = await request(ctx.server)
      .get(`/notification-logs/${sent.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(sentResponse.body.errorCode).toBeNull();
    expect(sentResponse.body.errorLabel).toBeNull();
  });

  it('passes an opaque providerMessageId through and withholds anything else', async () => {
    const cookie = await adminCookie();

    const opaque = await seedLog({
      providerMessageId: 'outbox-2f1c9d8e-0a11-4bd5-9f3c-77a1b2c3d4e5',
    });
    const opaqueResponse = await request(ctx.server)
      .get(`/notification-logs/${opaque.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(opaqueResponse.body.providerMessageId).toBe(
      'outbox-2f1c9d8e-0a11-4bd5-9f3c-77a1b2c3d4e5',
    );
    expect(opaqueResponse.body.providerMessageIdRedacted).toBe(false);

    // A future adapter that echoes the destination back as its correlation key
    // must not turn this field into an unmasked recipient.
    for (const unsafe of [
      'someone@example.test',
      '+90 555 999 88 77',
      '905559998877',
      'https://provider.example/messages/1',
      'msg 12 with spaces',
    ]) {
      const log = await seedLog({ providerMessageId: unsafe });
      const response = await request(ctx.server)
        .get(`/notification-logs/${log.id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.providerMessageId).toBeNull();
      expect(response.body.providerMessageIdRedacted).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain(unsafe);
    }

    const absent = await seedLog({ providerMessageId: null });
    const absentResponse = await request(ctx.server)
      .get(`/notification-logs/${absent.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(absentResponse.body.providerMessageId).toBeNull();
    expect(absentResponse.body.providerMessageIdRedacted).toBe(false);
  });

  it('classifies provider message ids without touching the database', () => {
    expect(projectProviderMessageId('outbox-abc123')).toEqual({
      providerMessageId: 'outbox-abc123',
      providerMessageIdRedacted: false,
    });
    expect(projectProviderMessageId('SM7f0a2b_9.c-1')).toEqual({
      providerMessageId: 'SM7f0a2b_9.c-1',
      providerMessageIdRedacted: false,
    });
    expect(projectProviderMessageId('a'.repeat(129)).providerMessageIdRedacted).toBe(true);
    expect(projectProviderMessageId('+905559998877').providerMessageIdRedacted).toBe(true);
    expect(projectProviderMessageId(null)).toEqual({
      providerMessageId: null,
      providerMessageIdRedacted: false,
    });
  });
});

describe('notification log — the rows real flows write', () => {
  it('shows a one-time code send as a masked SMS record with no code in it', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });
    const storedRequest = await ctx.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: serviceRequest.id },
    });

    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/phone-verification`)
      .set('Cookie', customerCookie)
      .expect(201);

    const code = ctx.sms.lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const response = await request(ctx.server)
      .get(listUrl('channel=SMS&template=phone-verification-code'))
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    const entry = response.body.items[0];
    expect(entry.channel).toBe(NotificationChannel.SMS);
    expect(entry.status).toBe(NotificationStatus.SENT);
    expect(entry.requestId).toBe(serviceRequest.id);
    expect(entry.userId).toBe(customer.id);
    expect(entry.maskedRecipient).toContain('*');

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(code);
    expect(body).not.toContain(storedRequest.customerPhone);
  });

  it('records a failed send as FAILED with its class, and nothing more', async () => {
    const cookie = await adminCookie();
    const category = await createCategory(ctx.prisma);
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const serviceRequest = await createApprovedRequest(ctx.prisma, {
      categoryId: category.id,
      customerId: customer.id,
    });

    ctx.sms.failNextSend = true;
    await request(ctx.server)
      .post(`/service-requests/${serviceRequest.id}/phone-verification`)
      .set('Cookie', customerCookie)
      .expect(201);

    const response = await request(ctx.server)
      .get(listUrl('status=FAILED'))
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].errorCode).toBe('TRANSPORT_UNAVAILABLE');
    expect(response.body.items[0].errorLabel).toBe('Taşıma servisi kullanılamıyor');
    expect(response.body.items[0].failedAt).not.toBeNull();
    expect(response.body.items[0].sentAt).toBeNull();
  });
});

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}
