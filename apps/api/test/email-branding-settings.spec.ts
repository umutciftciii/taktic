import { NotificationStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailBrandingService } from '../src/modules/notifications/email-branding.service';
import { NotificationDispatcher } from '../src/modules/notifications/notification-dispatcher.service';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import {
  ResendFetch,
  ResendNotificationAdapter,
} from '../src/modules/notifications/resend-notification.adapter';
import { SmsPort } from '../src/modules/notifications/sms.port';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  TestContext,
  createTestApp,
  createUser,
  loginAs,
  resetAuthThrottle,
  resetDatabase,
} from './harness';

/**
 * Company branding as admin-managed data, and what a delivering transport does
 * when it is missing.
 *
 * The rule this file replaces refused to boot the API without SUPPORT_EMAIL and
 * COMPANY_LEGAL_NAME in the environment. That was the wrong lever twice over:
 * it put business data in deployment configuration, and it answered "the footer
 * is unfinished" by taking the whole marketplace offline. What is proven here
 * instead is the pair of guarantees that actually matter — the process starts,
 * and no recipient ever receives a message whose footer this deployment could
 * not honestly fill in.
 *
 * Nothing in this file reaches a network. The delivering adapter is constructed
 * with a stand-in for `fetch`, and the key below is a syntactically valid
 * placeholder that was never issued.
 */

const PLACEHOLDER_KEY = 're_TESTKEY_not_a_real_credential';
const VERIFIED_SENDER = 'Taktick <noreply@notify.taktick.com.tr>';
const PUBLIC_WEB_URL = 'https://app.example.test';

/** A saveable, deliverable settings row. The domain is fictional and unowned. */
const REAL_SETTINGS = {
  legalName: 'Örnek Teknoloji Anonim Şirketi',
  supportEmail: 'destek@ornek-teknoloji.com.tr',
  postalAddress: 'Bir Cadde No:1, Çankaya/Ankara',
};

const MANAGED_ENV = [
  'EMAIL_TRANSPORT',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'NOTIFICATION_OUTBOX_DIR',
  'WEB_APP_URL',
  'WEB_ORIGIN',
  'NEXT_PUBLIC_WEB_URL',
  'EMAIL_ASSET_BASE_URL',
  'SUPPORT_EMAIL',
  'COMPANY_LEGAL_NAME',
  'COMPANY_POSTAL_ADDRESS',
] as const;

let ctx: TestContext;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetAuthThrottle(ctx.app);
  ctx.notifications.clear();

  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) {
    delete process.env[name];
  }
  process.env.EMAIL_TRANSPORT = 'console';
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

/** Points the process at the one transport that reaches a stranger's inbox. */
function selectDeliveringTransport() {
  process.env.EMAIL_TRANSPORT = 'resend';
  process.env.RESEND_API_KEY = PLACEHOLDER_KEY;
  process.env.EMAIL_FROM = VERIFIED_SENDER;
  // Technical configuration, and still boot-enforced: every link in the message
  // is built from it. Without this the resolver could not even name the logo.
  process.env.WEB_APP_URL = PUBLIC_WEB_URL;
}

async function adminCookie(): Promise<string> {
  const admin = await createUser(ctx.prisma, { role: UserRole.SUPER_ADMIN });
  return loginAs(ctx.prisma, admin.id);
}

/** Returns the supertest request itself, so callers can chain `.expect(...)`. */
function saveSettings(cookie: string, body: Record<string, unknown>) {
  return request(ctx.server).put('/company-settings').set('Cookie', cookie).send(body);
}

function brandingService(): EmailBrandingService {
  return new EmailBrandingService(ctx.app.get(PrismaService));
}

/**
 * The real delivering adapter and the real dispatcher, wired to a `fetch` that
 * records instead of calling out. Everything between the caller and the network
 * is production code — including the branding gate under test.
 */
function deliveringStack() {
  const requests: unknown[] = [];
  const fetchImpl: ResendFetch = async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'test-message-id' }) };
  };

  const adapter = new ResendNotificationAdapter(brandingService(), fetchImpl);
  const dispatcher = new NotificationDispatcher(
    ctx.app.get(PrismaService),
    adapter,
    ctx.app.get(SmsPort),
  );

  return { requests, dispatcher };
}

function designedMessage(): NotificationMessage {
  return {
    template: 'request-received',
    to: 'musteri@example.com',
    subject: 'Talebiniz alındı — inceleniyor',
    data: {
      fullName: 'Deniz Yılmaz',
      requestNumber: '#T-90412',
      categoryName: 'Kombi Servisi',
      city: 'Ankara',
      district: 'Çankaya',
      statusLabel: 'İnceleniyor',
      requestUrl: `${PUBLIC_WEB_URL}/requests/r1/offers`,
      accountUrl: `${PUBLIC_WEB_URL}/account/profile`,
    },
  };
}

describe('company settings — who may read and write them', () => {
  it('lets a SUPER_ADMIN save the row and read it back', async () => {
    const cookie = await adminCookie();

    const before = await request(ctx.server)
      .get('/company-settings')
      .set('Cookie', cookie)
      .expect(200);

    // Nothing is seeded, so the first visit says so rather than showing blanks
    // that look like saved empty values.
    expect(before.body.configured).toBe(false);
    expect(before.body.issues).toEqual(['NOT_CONFIGURED']);
    expect(before.body.legalName).toBeNull();

    const saved = await saveSettings(cookie, REAL_SETTINGS).expect(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.issues).toEqual([]);
    expect(saved.body.legalName).toBe(REAL_SETTINGS.legalName);
    expect(saved.body.supportEmail).toBe(REAL_SETTINGS.supportEmail);
    expect(saved.body.postalAddress).toBe(REAL_SETTINGS.postalAddress);
    expect(saved.body.updatedBy?.id).toBeTruthy();

    const after = await request(ctx.server)
      .get('/company-settings')
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.legalName).toBe(REAL_SETTINGS.legalName);
  });

  it('keeps exactly one row however many times it is saved', async () => {
    const cookie = await adminCookie();

    await saveSettings(cookie, REAL_SETTINGS).expect(200);
    await saveSettings(cookie, { ...REAL_SETTINGS, legalName: 'İkinci Unvan A.Ş.' }).expect(200);

    const rows = await ctx.prisma.companySettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('singleton');
    expect(rows[0]!.legalName).toBe('İkinci Unvan A.Ş.');
  });

  it('refuses every role but SUPER_ADMIN, and anonymous callers', async () => {
    const customer = await createUser(ctx.prisma, { role: UserRole.CUSTOMER });
    const provider = await createUser(ctx.prisma, { role: UserRole.PROVIDER });
    const customerCookie = await loginAs(ctx.prisma, customer.id);
    const providerCookie = await loginAs(ctx.prisma, provider.id);

    for (const cookie of [customerCookie, providerCookie]) {
      await request(ctx.server).get('/company-settings').set('Cookie', cookie).expect(403);
      await request(ctx.server)
        .put('/company-settings')
        .set('Cookie', cookie)
        .send(REAL_SETTINGS)
        .expect(403);
    }

    await request(ctx.server).get('/company-settings').expect(401);
    await request(ctx.server).put('/company-settings').send(REAL_SETTINGS).expect(401);

    // A refused write wrote nothing.
    expect(await ctx.prisma.companySettings.count()).toBe(0);
  });

  it('never returns a transport secret or a sender address', async () => {
    selectDeliveringTransport();
    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);

    const response = await request(ctx.server)
      .get('/company-settings')
      .set('Cookie', cookie)
      .expect(200);

    const body = JSON.stringify(response.body);
    for (const forbidden of [PLACEHOLDER_KEY, 'resend', 'RESEND', 'apiKey', 'noreply', 'EMAIL_FROM']) {
      expect(body).not.toContain(forbidden);
    }
    // Nor the operator's own address, which is not part of this answer.
    expect(body).not.toContain('@example.com');
  });
});

describe('company settings — what may be saved', () => {
  it('refuses a blank, short or missing legal name', async () => {
    const cookie = await adminCookie();

    await saveSettings(cookie, { ...REAL_SETTINGS, legalName: '   ' }).expect(400);
    await saveSettings(cookie, { ...REAL_SETTINGS, legalName: 'X' }).expect(400);
    await saveSettings(cookie, { supportEmail: REAL_SETTINGS.supportEmail }).expect(400);

    expect(await ctx.prisma.companySettings.count()).toBe(0);
  });

  it('refuses a support address that is not an address', async () => {
    const cookie = await adminCookie();

    for (const supportEmail of ['', '   ', 'destek sayfası', 'destek@', '@ornek.com.tr', 'destek@ornek']) {
      await saveSettings(cookie, { ...REAL_SETTINGS, supportEmail }).expect(400);
    }

    expect(await ctx.prisma.companySettings.count()).toBe(0);
  });

  it('refuses the development placeholders spelled out by hand', async () => {
    const cookie = await adminCookie();

    await saveSettings(cookie, { ...REAL_SETTINGS, supportEmail: 'destek@example.test' }).expect(400);
    await saveSettings(cookie, { ...REAL_SETTINGS, legalName: 'TakTick' }).expect(400);

    expect(await ctx.prisma.companySettings.count()).toBe(0);
  });

  it('trims, lower-cases the address, and treats a blank postal address as none', async () => {
    const cookie = await adminCookie();

    const saved = await saveSettings(cookie, {
      legalName: '  Örnek Teknoloji Anonim Şirketi  ',
      supportEmail: '  Destek@Ornek-Teknoloji.Com.TR ',
      postalAddress: '   ',
    }).expect(200);

    expect(saved.body.legalName).toBe('Örnek Teknoloji Anonim Şirketi');
    expect(saved.body.supportEmail).toBe('destek@ornek-teknoloji.com.tr');
    // Null rather than an empty string: the footer drops the line entirely.
    expect(saved.body.postalAddress).toBeNull();
    expect(saved.body.issues).toEqual([]);
  });

  it('reports a saved-but-undeliverable address rather than silently accepting it', async () => {
    // Reserved by RFC 6761: saveable while a staging stack is being set up, and
    // never publishable — the screen says so, and the transport refuses it.
    const cookie = await adminCookie();

    const saved = await saveSettings(cookie, {
      ...REAL_SETTINGS,
      supportEmail: 'destek@ornek.example',
    }).expect(200);

    expect(saved.body.configured).toBe(true);
    expect(saved.body.issues).toEqual(['SUPPORT_EMAIL_NOT_DELIVERABLE']);
  });

  it('ignores a field the form has no business sending', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, { ...REAL_SETTINGS, supportPhone: '05320000000' }).expect(400);
  });
});

describe('the footer a send resolves', () => {
  it('shows the unroutable placeholder when nothing delivers', async () => {
    const resolution = await brandingService().resolve();

    expect(resolution.complete).toBe(true);
    if (!resolution.complete) return;
    expect(resolution.branding.supportEmail).toBe('destek@example.test');
    expect(resolution.branding.companyName).toBe('TakTick');
  });

  it('prefers the saved row over the placeholder, even on the console transport', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);

    const resolution = await brandingService().resolve();
    expect(resolution.complete).toBe(true);
    if (!resolution.complete) return;
    expect(resolution.branding.companyName).toBe(REAL_SETTINGS.legalName);
    expect(resolution.branding.supportEmail).toBe(REAL_SETTINGS.supportEmail);
  });

  it('is incomplete for a delivering transport with no settings at all', async () => {
    selectDeliveringTransport();

    const resolution = await brandingService().resolve();
    expect(resolution.complete).toBe(false);
    if (resolution.complete) return;
    expect(resolution.issues).toEqual(['NOT_CONFIGURED']);
  });

  it('is incomplete for a delivering transport whose address nobody could write to', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, { ...REAL_SETTINGS, supportEmail: 'destek@ornek.example' }).expect(200);
    selectDeliveringTransport();

    const resolution = await brandingService().resolve();
    expect(resolution.complete).toBe(false);
    if (resolution.complete) return;
    expect(resolution.issues).toEqual(['SUPPORT_EMAIL_NOT_DELIVERABLE']);
  });

  it('is complete for a delivering transport once the row is saved', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);
    selectDeliveringTransport();

    const resolution = await brandingService().resolve();
    expect(resolution.complete).toBe(true);
    if (!resolution.complete) return;
    expect(resolution.branding).toEqual({
      companyName: REAL_SETTINGS.legalName,
      supportEmail: REAL_SETTINGS.supportEmail,
      companyAddress: REAL_SETTINGS.postalAddress,
      logoUrl: `${PUBLIC_WEB_URL}/brand/logo-email.png`,
    });
  });

  it('falls back to the deprecated variables while no row exists', async () => {
    selectDeliveringTransport();
    process.env.COMPANY_LEGAL_NAME = 'Eski Yapılandırma A.Ş.';
    process.env.SUPPORT_EMAIL = 'destek@eski-yapilandirma.com.tr';

    const resolution = await brandingService().resolve();
    expect(resolution.complete).toBe(true);
    if (!resolution.complete) return;
    expect(resolution.branding.companyName).toBe('Eski Yapılandırma A.Ş.');

    // …and the row wins the moment there is one.
    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);

    const afterSave = await brandingService().resolve();
    expect(afterSave.complete).toBe(true);
    if (!afterSave.complete) return;
    expect(afterSave.branding.companyName).toBe(REAL_SETTINGS.legalName);
  });
});

describe('a delivering send with incomplete settings', () => {
  it('starts the process anyway — a missing footer is not a boot failure', async () => {
    selectDeliveringTransport();

    // The application under test is already running with no settings row, and
    // the checks main.ts performs are these. None of them looks at the footer.
    const { assertPublicUrlConfig } = await import('../src/common/public-urls');
    const { assertEmailBrandingConfig } = await import(
      '../src/modules/notifications/email-branding.config'
    );
    const { assertEmailTransportConfig } = await import(
      '../src/modules/notifications/email-transport'
    );

    expect(() => assertPublicUrlConfig()).not.toThrow();
    expect(() => assertEmailBrandingConfig()).not.toThrow();
    expect(() => assertEmailTransportConfig()).not.toThrow();
    expect(await ctx.prisma.companySettings.count()).toBe(0);
  });

  it('records FAILED with EMAIL_BRANDING_INCOMPLETE and sends nothing', async () => {
    selectDeliveringTransport();
    const { requests, dispatcher } = deliveringStack();

    const outcome = await dispatcher.sendEmail(designedMessage());

    expect(outcome.status).toBe(NotificationStatus.FAILED);
    expect(outcome.errorCode).toBe('EMAIL_BRANDING_INCOMPLETE');
    // Nothing was handed to the transport: the refusal happens before the
    // request body exists, so no recipient can receive a half-filled footer.
    expect(requests).toHaveLength(0);

    const log = await ctx.prisma.notificationLog.findUniqueOrThrow({
      where: { id: outcome.logId },
    });
    expect(log.status).toBe(NotificationStatus.FAILED);
    expect(log.errorCode).toBe('EMAIL_BRANDING_INCOMPLETE');
    expect(log.providerMessageId).toBeNull();
    expect(log.failedAt).not.toBeNull();
    // The audit row stays as poor in detail as every other one.
    expect(log.maskedRecipient).not.toContain('musteri@example.com');
  });

  it('refuses just as firmly when the saved address is undeliverable', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, { ...REAL_SETTINGS, supportEmail: 'destek@ornek.example' }).expect(200);
    selectDeliveringTransport();

    const { requests, dispatcher } = deliveringStack();
    const outcome = await dispatcher.sendEmail(designedMessage());

    expect(outcome.errorCode).toBe('EMAIL_BRANDING_INCOMPLETE');
    expect(requests).toHaveLength(0);
  });

  it('still delivers the templates that print no company footer', async () => {
    selectDeliveringTransport();
    const { requests, dispatcher } = deliveringStack();

    // A claim invitation is the proof of mailbox ownership the whole flow rests
    // on, and it carries no company details at all. Blocking it over a footer
    // it never prints would be collateral damage, not safety.
    const outcome = await dispatcher.sendEmail({
      template: 'provider-claim',
      to: 'basvuru@example.com',
      subject: 'TakTic hizmet veren başvurunuzu hesabınıza bağlayın',
      actionUrl: `${PUBLIC_WEB_URL}/claim-provider?token=single-use-secret`,
      data: { businessName: 'Örnek Yapı' },
    });

    expect(outcome.status).toBe(NotificationStatus.SENT);
    expect(requests).toHaveLength(1);
  });

  it('sends the real footer once the settings are saved', async () => {
    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);
    selectDeliveringTransport();

    const { requests, dispatcher } = deliveringStack();
    const outcome = await dispatcher.sendEmail(designedMessage());

    expect(outcome.status).toBe(NotificationStatus.SENT);
    expect(requests).toHaveLength(1);

    const body = requests[0] as { html: string; text: string };
    expect(body.html).toContain(REAL_SETTINGS.supportEmail);
    expect(body.html).toContain(REAL_SETTINGS.legalName);
    expect(body.html).toContain(REAL_SETTINGS.postalAddress);
    expect(body.text).toContain(REAL_SETTINGS.supportEmail);

    // And none of what it replaced. (The links legitimately carry WEB_APP_URL,
    // which is technical configuration and points at app.example.test here —
    // what must not appear is the branding placeholder.)
    expect(body.html).not.toContain('destek@example.test');
    expect(body.html).not.toContain('TakTick ·');
    expect(body.html).not.toContain('localhost');
    // The footer's contact line is a real mailto, not a dead placeholder link.
    expect(body.html).toContain(`mailto:${REAL_SETTINGS.supportEmail}`);
  });

  it('picks up a corrected footer on the very next message', async () => {
    selectDeliveringTransport();
    const { requests, dispatcher } = deliveringStack();

    expect((await dispatcher.sendEmail(designedMessage())).errorCode).toBe(
      'EMAIL_BRANDING_INCOMPLETE',
    );

    const cookie = await adminCookie();
    await saveSettings(cookie, REAL_SETTINGS).expect(200);

    // No restart, no cache to bust: the resolver reads the row per send.
    expect((await dispatcher.sendEmail(designedMessage())).status).toBe(NotificationStatus.SENT);
    expect(requests).toHaveLength(1);
  });
});
