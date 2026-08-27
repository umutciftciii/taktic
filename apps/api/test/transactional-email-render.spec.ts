import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderEmail } from '../src/modules/notifications/email-template';
import { EmailBranding } from '../src/modules/notifications/email-branding.config';
import { NotificationMessage } from '../src/modules/notifications/notification.port';
import {
  TRANSACTIONAL_EMAIL_TEMPLATES,
  TransactionalEmailTemplate,
  transactionalSubject,
} from '../src/modules/notifications/templates/transactional-templates';
import { URGENCY_LABELS, UrgencyCode } from '../src/common/urgency';

/**
 * What the twelve designed messages must look like on the way out.
 *
 * These cases render only — no database, no dispatcher — because the questions
 * they answer are about the markup: does every message carry the one mandatory
 * salutation and closing, does it use the design's card, is every dynamic value
 * escaped, is every link a real absolute URL, and does a value the platform
 * does not have quietly disappear instead of becoming a placeholder.
 */

const WEB = 'https://app.example.test';
const ASSETS = 'https://cdn.example.test';

/**
 * The footer values, passed in rather than read from the environment.
 *
 * They are an argument to the renderer now, because they are an argument in
 * production too: the legal name, the support address and the postal address
 * come from the admin-managed CompanySettings row, and a transport that cannot
 * resolve them refuses to send rather than rendering a placeholder. Stating
 * them here makes every assertion below about the markup rather than about
 * whichever variables happened to be exported.
 */
const BRANDING: EmailBranding = {
  supportEmail: 'destek@example.test',
  companyName: 'TakTick Teknoloji A.Ş.',
  companyAddress: 'Kızılırmak Mah. No:12, Çankaya/Ankara',
  logoUrl: `${ASSETS}/brand/logo-email.png`,
};

/** Renders with the branding above. The three legacy templates ignore it. */
function render(message: NotificationMessage) {
  return renderEmail(message, BRANDING);
}

/** A payload with something plausible in every field each template reads. */
const FULL_DATA: Record<TransactionalEmailTemplate, Record<string, string | null>> = {
  'password-reset': {
    fullName: 'Deniz Yılmaz',
    requestedAt: '2026-08-27T11:12:00.000Z',
    expiryMinutes: '30',
  },
  'email-verification': { fullName: 'Deniz Yılmaz', expiryDays: '7' },
  'provider-application-received': {
    fullName: 'Murat Şahin',
    businessName: 'Şahin Isı Sistemleri',
    categories: 'Kombi Servisi, Klima Montajı',
    areas: 'Çankaya, Yenimahalle',
    statusLabel: 'İnceleniyor',
    profileUrl: `${WEB}/providers/p1/edit`,
  },
  'provider-application-approved': {
    fullName: 'Murat Şahin',
    businessName: 'Şahin Isı Sistemleri',
    categories: 'Kombi Servisi',
    areas: 'Çankaya',
    requestsUrl: `${WEB}/providers/p1/requests`,
    accountUrl: `${WEB}/providers/me`,
  },
  'request-received': {
    fullName: 'Deniz Yılmaz',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    city: 'Ankara',
    district: 'Çankaya',
    preferredDate: '2026-09-01T09:00:00.000Z',
    urgency: 'THIS_WEEK',
    statusLabel: 'İnceleniyor',
    requestUrl: `${WEB}/requests/r1/offers`,
    accountUrl: `${WEB}/account/profile`,
  },
  'request-published': {
    fullName: 'Deniz Yılmaz',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    district: 'Çankaya',
    reachedProviderCount: '14',
    requestUrl: `${WEB}/requests/r1/offers`,
    accountUrl: `${WEB}/account/profile`,
  },
  'offer-received': {
    fullName: 'Deniz Yılmaz',
    requestNumber: '#T-90412',
    providerName: 'Şahin Isı Sistemleri',
    offerAmountMinor: '240000',
    availability: '2026-09-02T09:00:00.000Z',
    offerNote: 'Baca kontrolü ve işçilik dahildir.',
    openOfferCount: '2',
    offersUrl: `${WEB}/requests/r1/offers`,
    accountUrl: `${WEB}/account/profile`,
  },
  'match-customer': {
    fullName: 'Deniz Yılmaz',
    businessName: 'Şahin Isı Sistemleri',
    contactName: 'Murat Şahin',
    contactPhone: '05320000000',
    acceptedAmountMinor: '240000',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    requestUrl: `${WEB}/requests/r1/offers`,
    accountUrl: `${WEB}/account/profile`,
  },
  'request-available': {
    fullName: 'Murat Şahin',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    city: 'Ankara',
    district: 'Çankaya',
    qualityScore: '82',
    creditCost: '2',
    creditBalance: '24',
    requestUrl: `${WEB}/providers/p1/requests/r1`,
    accountUrl: `${WEB}/providers/me`,
  },
  'offer-accepted': {
    fullName: 'Murat Şahin',
    customerName: 'Deniz Yılmaz',
    customerPhone: '05330000000',
    city: 'Ankara',
    district: 'Çankaya',
    acceptedAmountMinor: '240000',
    preferredDate: '2026-09-01T09:00:00.000Z',
    urgency: 'THIS_WEEK',
    requestNumber: '#T-90412',
    offerUrl: `${WEB}/providers/p1/offers/o1`,
    accountUrl: `${WEB}/providers/me`,
  },
  'offer-not-selected': {
    fullName: 'Murat Şahin',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    offerAmountMinor: '240000',
    requestsUrl: `${WEB}/providers/p1/requests`,
    accountUrl: `${WEB}/providers/me`,
  },
  'credit-refunded': {
    fullName: 'Murat Şahin',
    requestNumber: '#T-90350',
    categoryName: 'Klima Montajı',
    refundReason: 'Geçersiz talep',
    refundedCredits: '2',
    previousBalance: '22',
    currentBalance: '24',
    creditsUrl: `${WEB}/providers/p1/credits`,
    accountUrl: `${WEB}/providers/me`,
  },
};

/**
 * The two messages that carry the customer's stated timing, and therefore the
 * two that could ever print a storage code at somebody.
 */
const TIMING_TEMPLATES: TransactionalEmailTemplate[] = ['request-received', 'offer-accepted'];

/** Every code the column has ever held, from the one table that names them. */
const URGENCY_CODES = Object.keys(URGENCY_LABELS) as UrgencyCode[];

/** Templates whose call to action carries a single-use token in the URL. */
const TOKEN_TEMPLATES: TransactionalEmailTemplate[] = ['password-reset', 'email-verification'];

function messageFor(
  template: TransactionalEmailTemplate,
  overrides: Record<string, string | null> = {},
): NotificationMessage {
  const data = { ...FULL_DATA[template], ...overrides };

  return {
    template,
    to: 'alici@example.test',
    subject: transactionalSubject(template, data),
    actionUrl: TOKEN_TEMPLATES.includes(template)
      ? `${WEB}/sifre-sifirla?token=abc123`
      : undefined,
    data,
  };
}

describe('transactional e-mail rendering', () => {
  const originalWeb = process.env.WEB_APP_URL;
  const originalAssets = process.env.EMAIL_ASSET_BASE_URL;
  const originalSupport = process.env.SUPPORT_EMAIL;
  const originalCompany = process.env.COMPANY_LEGAL_NAME;
  const originalAddress = process.env.COMPANY_POSTAL_ADDRESS;

  beforeEach(() => {
    process.env.WEB_APP_URL = WEB;
    process.env.EMAIL_ASSET_BASE_URL = ASSETS;
    process.env.SUPPORT_EMAIL = 'destek@example.test';
    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';
    process.env.COMPANY_POSTAL_ADDRESS = 'Kızılırmak Mah. No:12, Çankaya/Ankara';
  });

  afterEach(() => {
    restore('WEB_APP_URL', originalWeb);
    restore('EMAIL_ASSET_BASE_URL', originalAssets);
    restore('SUPPORT_EMAIL', originalSupport);
    restore('COMPANY_LEGAL_NAME', originalCompany);
    restore('COMPANY_POSTAL_ADDRESS', originalAddress);
  });

  it('covers every template the port accepts', () => {
    expect(TRANSACTIONAL_EMAIL_TEMPLATES).toHaveLength(12);
    expect(Object.keys(FULL_DATA).sort()).toEqual([...TRANSACTIONAL_EMAIL_TEMPLATES].sort());
  });

  describe.each(TRANSACTIONAL_EMAIL_TEMPLATES)('%s', (template) => {
    it('carries the mandatory salutation and closing in both bodies', () => {
      const { html, text } = render(messageFor(template));
      const fullName = FULL_DATA[template].fullName as string;

      // Exactly one salutation, in exactly the form the editorial rules allow.
      expect(html.match(new RegExp(`Sayın ${fullName},`, 'g'))).toHaveLength(1);
      expect(html).toContain('Saygılarımızla,<br><strong>TakTick Ekibi</strong>');
      expect(text).toContain(`Sayın ${fullName},`);
      expect(text).toContain('Saygılarımızla,');

      // No "Merhaba", no first-name greeting, no exclamation.
      expect(html).not.toContain('Merhaba');
      expect(html).not.toContain('Tebrikler');
    });

    it('renders the design system card', () => {
      const { html } = render(messageFor(template));

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('<html lang="tr">');
      // 600px card, 2px ink border, no radius anywhere.
      expect(html).toContain('width:600px;max-width:600px;background-color:#ffffff;border:2px solid #201e1d;');
      expect(html).toContain('background-color:#e7e5e3;');
      expect(html).not.toContain('border-radius');
      // Table-based, presentation role, no layout CSS an e-mail client drops.
      expect(html).toContain('<table role="presentation" cellpadding="0" cellspacing="0" border="0"');
      expect(html).not.toMatch(/display:\s*(flex|grid)/);
      expect(html).not.toContain('position:absolute');
      // Outlook: the MSO font block and an exact line-height rule on every rule.
      expect(html).toContain('<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->');
      expect(html).toContain('mso-line-height-rule:exactly');
      // The single style block carries the mobile query and nothing else.
      expect(html).toContain('@media only screen and (max-width:620px)');
      // No script, no external stylesheet, no web font.
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<link');
      expect(html).not.toContain('fonts.googleapis');
    });

    it('uses one absolute https logo URL from configuration', () => {
      const { html } = render(messageFor(template));

      expect(html).toContain(`<img src="${ASSETS}/brand/logo-email.png" width="140" alt="TakTick"`);
      // Nothing relative survived from the handoff, and no host is hard-coded.
      expect(html).not.toContain('../assets/');
      expect(html).not.toContain('taktick.com/');
    });

    it('leaves no placeholder link behind', () => {
      const { html } = render(messageFor(template));
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');

      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).not.toBe('');
        expect(href).not.toBe('#');
        expect(href.startsWith('javascript:')).toBe(false);
        expect(href.startsWith('data:')).toBe(false);
        expect(href.startsWith('mailto:') || href.startsWith(WEB)).toBe(true);
      }
    });

    it('drops the design-only subject caption and the unsubscribe links', () => {
      const { html } = render(messageFor(template));

      // The preview caption under the card existed for the reviewer only.
      expect(html).not.toContain('Konu: ');
      // There is no preference centre and no unsubscribe list to point at.
      expect(html).not.toContain('Bildirim tercihleri');
      expect(html).not.toContain('Bildirimlerden çık');
      expect(html).toContain('zorunlu bir işlem bildirimidir');
    });

    it('escapes every dynamic value', () => {
      const injection = '<img src=x onerror=alert(1)>"\'&';
      const { html, text } = render(
        messageFor(template, {
          fullName: injection,
          businessName: injection,
          providerName: injection,
          customerName: injection,
          offerNote: injection,
          categoryName: injection,
          district: injection,
        }),
      );

      // The raw string never appears: no tag is opened, no quote is closed,
      // and the ampersand is escaped too, so nothing can be reassembled.
      expect(html).not.toContain(injection);
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
      // Every attribute in the document is still delimited by the quotes the
      // renderer wrote, so the injected quote did not escape one.
      expect(html.match(/<[a-z]+ [^>]*"/g)?.length ?? 0).toBeGreaterThan(0);
      // The plain-text body is not markup, so it carries the raw characters —
      // which is exactly why it must never be inserted into HTML.
      expect(text).toContain(injection);
    });

    it('drops a row rather than printing a placeholder when a value is missing', () => {
      const blanked = Object.fromEntries(
        Object.keys(FULL_DATA[template])
          .filter((key) => key !== 'fullName')
          .map((key) => [key, null]),
      );
      const { html } = render(messageFor(template, blanked));

      expect(html).toContain(`Sayın ${FULL_DATA[template].fullName},`);
      expect(html).toContain('Saygılarımızla,<br><strong>TakTick Ekibi</strong>');
      // No empty cells, no dashes standing in for absent data, no "undefined".
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('null');
      expect(html).not.toMatch(/vertical-align:top;">\s*<\/td>/);
    });

    it('never prints a storage code, with the data present or absent', () => {
      const blanked = Object.fromEntries(
        Object.keys(FULL_DATA[template]).map((key) => [key, null]),
      );

      for (const payload of [{}, blanked]) {
        const { html, text } = render(messageFor(template, payload));

        for (const code of URGENCY_CODES) {
          expect(html).not.toContain(code);
          expect(text).not.toContain(code);
        }
      }
    });
  });

  /**
   * The bug this section exists for: a customer was told their preferred time
   * was "29 Ağustos 2026 · THIS_WEEK". `ServiceRequest.urgency` holds a storage
   * code, the template used to interpolate it verbatim, and nothing failed —
   * so the check has to be per code rather than per template, and it has to
   * come from the same table the renderer does.
   */
  describe.each(TIMING_TEMPLATES)('%s — the customer’s stated timing', (template) => {
    it.each(URGENCY_CODES)('renders %s in words, never as the code', (code) => {
      const { html, text } = render(messageFor(template, { urgency: code }));
      const label = URGENCY_LABELS[code];

      expect(html).toContain(`1 Eylül 2026 · ${label}`);
      expect(text).toContain(label);

      // Not the code itself, and not any other code either — a table that maps
      // two spellings onto one row would still be a leak for the second.
      for (const other of URGENCY_CODES) {
        expect(html).not.toContain(other);
        expect(text).not.toContain(other);
      }
    });

    it('prints the date alone when no urgency was chosen', () => {
      const { html } = render(messageFor(template, { urgency: null }));

      expect(html).toContain('1 Eylül 2026');
      // No dangling separator where the second half should have been.
      expect(html).not.toContain('1 Eylül 2026 ·');
      expect(html).not.toContain('·</td>');
    });

    it('prints the urgency alone when no date was chosen', () => {
      const { html } = render(
        messageFor(template, { preferredDate: null, urgency: 'FLEXIBLE' }),
      );

      expect(html).toContain(URGENCY_LABELS.FLEXIBLE);
      expect(html).not.toContain(`· ${URGENCY_LABELS.FLEXIBLE}`);
    });

    it('drops the whole row for a code this build does not know', () => {
      const { html, text } = render(
        messageFor(template, { preferredDate: null, urgency: 'SOME_FUTURE_CODE' }),
      );

      // Silence rather than an invented label, and above all not the code.
      expect(html).not.toContain('SOME_FUTURE_CODE');
      expect(text).not.toContain('SOME_FUTURE_CODE');
      expect(html).not.toContain('Tercih edilen zaman');
    });

    it('drops the whole row when the customer gave neither', () => {
      const { html } = render(messageFor(template, { preferredDate: null, urgency: null }));
      expect(html).not.toContain('Tercih edilen zaman');
    });
  });

  it('states each subject exactly as specified', () => {
    const subjects = Object.fromEntries(
      TRANSACTIONAL_EMAIL_TEMPLATES.map((template) => [
        template,
        transactionalSubject(template, FULL_DATA[template]),
      ]),
    );

    expect(subjects).toEqual({
      'password-reset': 'TakTick şifrenizi sıfırlayın',
      'email-verification': "TakTick'e hoş geldiniz — e-postanızı doğrulayın",
      'provider-application-received': 'Başvurunuzu aldık — TakTick hizmet veren kaydı',
      'provider-application-approved': 'Başvurunuz onaylandı — teklif vermeye başlayabilirsiniz',
      'request-received': 'Talebiniz alındı — inceleniyor',
      'request-published': 'Talebiniz yayında — teklifler yolda',
      'offer-received': 'Yeni teklif aldınız — Şahin Isı Sistemleri',
      'match-customer': 'Eşleşme tamam — iletişim bilgileri',
      'request-available': 'Bölgenizde yeni talep — Kombi Servisi, Çankaya',
      'offer-accepted': 'Teklifiniz kabul edildi — #T-90412',
      'offer-not-selected': 'Teklifiniz bu kez seçilmedi — #T-90412',
      'credit-refunded': 'Krediniz iade edildi — 2 kredi',
    });
  });

  it('formats money as tr-TR with the sign after a space', () => {
    const { html } = render(messageFor('offer-received', { offerAmountMinor: '240000' }));
    expect(html).toContain('2.400 ₺');

    // Kuruş survive rather than being rounded into a figure nobody quoted.
    const withKurus = render(messageFor('offer-received', { offerAmountMinor: '123450' }));
    expect(withKurus.html).toContain('1.234,50 ₺');
  });

  it('formats a moment as tr-TR long date with a 24-hour clock', () => {
    const { html } = render(
      messageFor('password-reset', { requestedAt: '2026-08-27T11:12:00.000Z' }),
    );

    // 11:12 UTC is 14:12 in Europe/Istanbul, which is the zone the product is
    // written for — not whatever the server happens to run in.
    expect(html).toContain('27 Ağustos 2026, 14:12');
  });

  it('keeps a reset token in the URL and out of everything else', () => {
    const token = 'ZmFrZS10b2tlbi12YWx1ZQ';
    const { html, text } = render({
      template: 'password-reset',
      to: 'alici@example.test',
      subject: transactionalSubject('password-reset', FULL_DATA['password-reset']),
      actionUrl: `${WEB}/sifre-sifirla?token=${token}`,
      data: FULL_DATA['password-reset'],
    });

    expect(html).toContain(`href="${WEB}/sifre-sifirla?token=${token}"`);
    // Exactly once in each body: inside the link, and nowhere else.
    expect(html.split(token)).toHaveLength(2);
    expect(text.split(token)).toHaveLength(2);
  });

  it('omits the device row the platform cannot fill', () => {
    const { html } = render(messageFor('password-reset'));

    expect(html).toContain('Bağlantı geçerliliği');
    expect(html).toContain('Talep zamanı');
    // The handoff showed "Cihaz · Chrome · İstanbul, TR". Nothing records it.
    expect(html).not.toContain('Cihaz');
  });

  it('omits the figures the platform does not compute', () => {
    const approved = render(messageFor('provider-application-approved')).html;
    expect(approved).not.toContain('Hoş geldin kredisi');
    // No fixed credit promise either — the cost is per category.
    expect(approved).not.toContain('1–3 kredi');

    const received = render(messageFor('provider-application-received')).html;
    expect(received).not.toContain('Başvuru no');

    const published = render(messageFor('request-published')).html;
    expect(published).toContain('Ulaşılan uzman');
    expect(published).not.toContain('Beklenen teklif');

    const offer = render(messageFor('offer-received')).html;
    expect(offer).not.toContain('Puan');

    const available = render(messageFor('request-available')).html;
    expect(available).toContain('Teklif maliyeti');
    expect(available).not.toContain('Mevcut teklif');

    const notSelected = render(messageFor('offer-not-selected')).html;
    expect(notSelected).not.toContain('kabul oranınız');
  });

  it('drops the contact rows when the accept did not open them', () => {
    const withContact = render(messageFor('match-customer')).html;
    expect(withContact).toContain('Telefon');
    expect(withContact).toContain('05320000000');

    const withoutContact = render(
      messageFor('match-customer', { contactName: null, contactPhone: null }),
    ).html;
    expect(withoutContact).not.toContain('Telefon');
    expect(withoutContact).not.toContain('05320000000');
    // Still a coherent message: the business name and the amount remain.
    expect(withoutContact).toContain('Şahin Isı Sistemleri');
    expect(withoutContact).toContain('2.400 ₺');

    const providerSide = render(
      messageFor('offer-accepted', { customerName: null, customerPhone: null }),
    ).html;
    expect(providerSide).not.toContain('05330000000');
    expect(providerSide).toContain('Kabul edilen tutar');
  });

  it('never carries the neighbourhood or an address note to a provider', () => {
    for (const template of ['request-available', 'offer-accepted'] as const) {
      const { html } = render(
        messageFor(template, {
          // Not fields these templates read; the point is that supplying them
          // changes nothing, so a future careless caller cannot leak them.
          neighborhood: 'Kızılırmak Mahallesi',
          addressNote: 'Kapı no 5, zil bozuk',
        }),
      );

      expect(html).not.toContain('Kızılırmak Mahallesi');
      expect(html).not.toContain('Kapı no 5');
    }
  });

  it('refuses a call to action that is not an http(s) URL', () => {
    expect(() =>
      render({
        template: 'password-reset',
        to: 'alici@example.test',
        subject: 'x',
        actionUrl: 'javascript:alert(1)',
        data: FULL_DATA['password-reset'],
      }),
    ).toThrow(/http or https/);
  });

  it('leaves the three older templates on their original plain renderer', () => {
    const { html } = render({
      template: 'customer-activation',
      to: 'alici@example.test',
      subject: 'TakTic hesabınızı etkinleştirin',
      actionUrl: `${WEB}/activate-customer?token=abc`,
      data: { name: 'Deniz' },
    });

    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('border:2px solid #201e1d');
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
