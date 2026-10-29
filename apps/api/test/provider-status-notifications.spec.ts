import { ProviderStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderEmail } from '../src/modules/notifications/email-template';
import type { NotificationMessage } from '../src/modules/notifications/notification.port';
import { TransactionalMailService } from '../src/modules/notifications/transactional-mail.service';
import {
  createCategory,
  createDiscoverableProvider,
  createProviderProfile,
  createTestApp,
  createUser,
  loginAs,
  resetDatabase,
  type TestContext,
} from './harness';

/**
 * PROVIDER-STATUS-001 PR-2: what a provider is told when an operator moves
 * their status.
 *
 * - Rejection, suspension and re-activation each mail their own notice, once
 *   per genuine transition (a same-status save mails nothing).
 * - A re-activation is not a second "application approved".
 * - No notice carries the operator's reason or note, in its data, subject,
 *   HTML or text; each points at the support route.
 * - A retry rebuilds a notice only while the status it describes still holds.
 */

let ctx: TestContext;
let mail: TransactionalMailService;

beforeAll(async () => {
  ctx = await createTestApp();
  mail = ctx.app.get(TransactionalMailService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.notifications.clear();
});

const SUSPENSION_REASON = 'GIZLI-ASKI-GEREKCESI şikâyet incelemesi';
const REJECTION_REASON = 'GIZLI-RET-GEREKCESI belge eksik';
const MODERATION_NOTE = 'GIZLI-IC-NOT telefonla arandı';
const SECRETS = [SUSPENSION_REASON, REJECTION_REASON, MODERATION_NOTE];

const BRANDING = {
  supportEmail: 'destek@example.test',
  companyName: 'TakTick Teknoloji A.Ş.',
  companyAddress: 'Kızılırmak Mah. No:12, Çankaya/Ankara',
  logoUrl: 'https://cdn.example.test/brand/logo-email.png',
};

async function rootCookie() {
  const root = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, root.id);
}

async function ownedProvider() {
  const category = await createCategory(ctx.prisma, 'Klima');
  const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
  const provider = await createDiscoverableProvider(ctx.prisma, { userId: owner.id, categoryId: category.id });
  return { provider, owner };
}

function setStatus(cookie: string, providerId: string, body: Record<string, unknown>) {
  return request(ctx.server).patch(`/providers/${providerId}/status`).set('Cookie', cookie).send(body).expect(200);
}

const suspendBody = { status: ProviderStatus.SUSPENDED, suspensionReason: SUSPENSION_REASON, moderationNote: MODERATION_NOTE };
const rejectBody = { status: ProviderStatus.REJECTED, rejectionReason: REJECTION_REASON, moderationNote: MODERATION_NOTE };

function sent(template: NotificationMessage['template']) {
  return ctx.notifications.ofTemplate(template);
}

/** Nothing of the moderation anywhere in the message: data, subject, HTML, text. */
function expectNoModeration(message: NotificationMessage) {
  const rendered = renderEmail(message, BRANDING);
  const everything = [JSON.stringify(message.data), message.subject, rendered.html, rendered.text].join('\n');
  for (const secret of SECRETS) expect(everything).not.toContain(secret);
  expect(Object.keys(message.data ?? {}).sort()).toEqual(['accountUrl', 'businessName', 'fullName', 'requestsUrl', 'supportUrl']);
  // General and neutral: no accusation, no finding.
  expect(everything).not.toMatch(/ihlal|suç|dolandır|sahte|şikâyet|Sebep:/i);
  expect(rendered.html).toContain('/destek');
}

describe('the three status notices', () => {
  it('suspension: one notice to the owner, neutral, no reason or note; a same-status save mails nothing', async () => {
    const root = await rootCookie();
    const { provider, owner } = await ownedProvider();

    await setStatus(root, provider.id, suspendBody);
    await setStatus(root, provider.id, { ...suspendBody, moderationNote: 'ikinci not' });

    const notices = sent('provider-account-suspended');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to).toBe(owner.email);
    expect(notices[0]!.subject).toBe('Hesabınız hakkında bilgilendirme — TakTick hizmet veren paneli');
    expectNoModeration(notices[0]!);
    const { html } = renderEmail(notices[0]!, BRANDING);
    expect(html).toContain('yeni iş almaya kapalı');
    expect(html).toContain('Kabul edilmiş işler ve mesajlar');
  });

  it('rejection: one notice, neutral, no reason or note — the guest application’s own address when there is no account', async () => {
    const root = await rootCookie();
    const provider = await createProviderProfile(ctx.prisma, { status: ProviderStatus.PENDING_REVIEW });

    await setStatus(root, provider.id, rejectBody);
    await setStatus(root, provider.id, rejectBody);

    const notices = sent('provider-application-rejected');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to).toBe(provider.email);
    expectNoModeration(notices[0]!);
    expect(renderEmail(notices[0]!, BRANDING).html).toContain('şu aşamada onaylanmadı');
  });

  it('re-activation: its own notice, and no second "application approved"', async () => {
    const root = await rootCookie();
    const category = await createCategory(ctx.prisma, 'Klima');
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });
    await ctx.prisma.providerServiceCategory.create({ data: { providerId: provider.id, categoryId: category.id } });

    await setStatus(root, provider.id, { status: ProviderStatus.APPROVED });
    await setStatus(root, provider.id, suspendBody);
    await setStatus(root, provider.id, { status: ProviderStatus.APPROVED });

    expect(sent('provider-application-approved')).toHaveLength(1);
    expect(sent('provider-account-suspended')).toHaveLength(1);
    const reactivated = sent('provider-account-reactivated');
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0]!.subject).toBe('Hesabınız yeniden aktif — TakTick hizmet veren paneli');
    expectNoModeration(reactivated[0]!);

    // A second suspension and re-activation is told again (its own timestamps).
    await setStatus(root, provider.id, suspendBody);
    await setStatus(root, provider.id, { status: ProviderStatus.APPROVED });
    expect(sent('provider-account-suspended')).toHaveLength(2);
    expect(sent('provider-account-reactivated')).toHaveLength(2);
    expect(sent('provider-application-approved')).toHaveLength(1);
  });

  it('a rejected application approved later is a first approval, not a re-activation', async () => {
    const root = await rootCookie();
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: ProviderStatus.PENDING_REVIEW });

    await setStatus(root, provider.id, rejectBody);
    await setStatus(root, provider.id, { status: ProviderStatus.APPROVED });

    expect(sent('provider-application-rejected')).toHaveLength(1);
    expect(sent('provider-application-approved')).toHaveLength(1);
    expect(sent('provider-account-reactivated')).toHaveLength(0);
  });

  it('moves back to review or draft mail nothing', async () => {
    const root = await rootCookie();
    const { provider } = await ownedProvider();
    await setStatus(root, provider.id, { status: ProviderStatus.PENDING_REVIEW });
    await setStatus(root, provider.id, { status: ProviderStatus.DRAFT });
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('the notification log stores no reason or note either', async () => {
    const root = await rootCookie();
    const { provider } = await ownedProvider();
    await setStatus(root, provider.id, suspendBody);
    await setStatus(root, provider.id, { status: ProviderStatus.APPROVED });
    await setStatus(root, provider.id, rejectBody);

    const logs = await ctx.prisma.notificationLog.findMany({ where: { providerId: provider.id } });
    expect(logs.map((log) => log.template).sort()).toEqual(
      ['provider-account-reactivated', 'provider-account-suspended', 'provider-application-rejected'].sort(),
    );
    const text = JSON.stringify(logs);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('a retry rebuilds a notice only while its status holds', () => {
  async function failedLog(template: string, send: () => Promise<void>) {
    ctx.notifications.failNextSend = true;
    await send();
    ctx.notifications.clear();
    return ctx.prisma.notificationLog.findFirstOrThrow({ where: { template }, orderBy: { createdAt: 'desc' } });
  }

  async function retry(logId: string) {
    return request(ctx.server).post(`/notification-logs/${logId}/retry`).set('Cookie', await rootCookie()).expect(200);
  }

  it.each([
    ['provider-account-suspended', ProviderStatus.SUSPENDED, ProviderStatus.APPROVED],
    ['provider-application-rejected', ProviderStatus.REJECTED, ProviderStatus.PENDING_REVIEW],
    ['provider-account-reactivated', ProviderStatus.APPROVED, ProviderStatus.SUSPENDED],
  ] as const)('%s', async (template, holds, moved) => {
    const owner = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const provider = await createProviderProfile(ctx.prisma, { userId: owner.id, status: holds });
    const at = new Date();
    const send = {
      'provider-account-suspended': () => mail.sendProviderAccountSuspended(provider.id, at),
      'provider-application-rejected': () => mail.sendProviderApplicationRejected(provider.id, at),
      'provider-account-reactivated': () => mail.sendProviderAccountReactivated(provider.id, at),
    }[template];

    const log = await failedLog(template, send);
    const ok = await retry(log.id);
    expect(ok.body.status).not.toBe('FAILED');
    expect(ctx.notifications.ofTemplate(template)).toHaveLength(1);
    expectNoModeration(ctx.notifications.ofTemplate(template)[0]!);

    ctx.notifications.clear();
    const second = await failedLog(template, () =>
      ({
        'provider-account-suspended': () => mail.sendProviderAccountSuspended(provider.id, new Date(at.getTime() + 1000)),
        'provider-application-rejected': () => mail.sendProviderApplicationRejected(provider.id, new Date(at.getTime() + 1000)),
        'provider-account-reactivated': () => mail.sendProviderAccountReactivated(provider.id, new Date(at.getTime() + 1000)),
      })[template](),
    );
    await ctx.prisma.providerProfile.update({ where: { id: provider.id }, data: { status: moved } });
    const refused = await retry(second.id);
    expect(refused.body.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(ctx.notifications.sent).toHaveLength(0);
  });
});
