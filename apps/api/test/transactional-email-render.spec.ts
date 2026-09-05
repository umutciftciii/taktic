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
 * What every designed message must look like on the way out.
 *
 * These cases render only — no database, no dispatcher — because the questions
 * they answer are about the markup: does every message carry the one mandatory
 * salutation and closing, does it use the design's card, is every dynamic value
 * escaped, is every link a real absolute URL, and does a value the platform
 * does not have quietly disappear instead of becoming a placeholder.
 */

const WEB = 'https://app.example.test';
const ASSETS = 'https://cdn.example.test';
/** The operator panel, which only the two support-facing messages ever link to. */
const ADMIN = 'https://panel.example.test';

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

/** Renders with the branding above. Every template needs it — all print the footer. */
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
  // The three that moved onto the design system keep the variable names their
  // call sites have always passed. `customer-activation` greets from `name`,
  // which is why it has no `fullName` of its own.
  'customer-activation': { name: 'Deniz Yılmaz', expiresAt: '2026-08-29T11:12:00.000Z' },
  'provider-claim': {
    fullName: 'Murat Şahin',
    businessName: 'Şahin Isı Sistemleri',
    expiresAt: '2026-08-29T11:12:00.000Z',
  },
  'request-expiring': {
    fullName: 'Deniz Yılmaz',
    requestNumber: '#T-90412',
    categoryName: 'Kombi Servisi',
    openDays: '14',
    remainingDays: '7',
    expiresAt: '2026-09-05T11:12:00.000Z',
  },
  'package-purchase-confirmation': {
    fullName: 'Murat Şahin',
    packageName: 'Başlangıç Paketi',
    creditAmount: '30',
    priceAmountMinor: '49900',
    currency: 'TRY',
    purchaseNumber: '#P-10023',
    paidAt: '2026-08-27T11:12:00.000Z',
    creditsUrl: `${WEB}/providers/p1/credits`,
    accountUrl: `${WEB}/providers/me`,
  },
  'support-ticket-created': {
    fullName: 'Deniz Yılmaz',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Geçen haftaki talebimin faturası elime geçmedi.',
    status: 'OPEN',
    createdAt: '2026-08-27T11:12:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
  'support-ticket-new-for-support': {
    fullName: 'Destek Ekibi',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Geçen haftaki talebimin faturası elime geçmedi.',
    status: 'OPEN',
    createdAt: '2026-08-27T11:12:00.000Z',
    requesterName: 'Deniz Yılmaz',
    requesterEmail: 'deniz@example.test',
    requesterRoleLabel: 'Hizmet alan',
    ticketUrl: `${ADMIN}/support/tkt_c1a2b3`,
    accountUrl: null,
  },
  'support-ticket-customer-reply': {
    fullName: 'Destek Ekibi',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Ek olarak talep numaram #T-90412.',
    status: 'IN_PROGRESS',
    messageAt: '2026-08-28T09:00:00.000Z',
    requesterName: 'Deniz Yılmaz',
    requesterEmail: 'deniz@example.test',
    requesterRoleLabel: 'Hizmet alan',
    ticketUrl: `${ADMIN}/support/tkt_c1a2b3`,
    accountUrl: null,
  },
  'support-ticket-admin-reply': {
    fullName: 'Deniz Yılmaz',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Faturanızı yeniden gönderdik, ekte bulabilirsiniz.',
    status: 'IN_PROGRESS',
    messageAt: '2026-08-28T10:00:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
  'support-ticket-status-changed': {
    fullName: 'Deniz Yılmaz',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    fromStatus: 'IN_PROGRESS',
    status: 'RESOLVED',
    changedAt: '2026-08-28T12:00:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
  // The hizmet veren half of the family. Deliberately the same ticket
  // reference, subject and excerpts as the hizmet alan fixtures above: the
  // assertions below are about which audience gets which fields, and giving the
  // two sets different content would let a template pass by printing the other
  // desk's data.
  'support-ticket-provider-created': {
    fullName: 'Murat Şahin',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Geçen haftaki talebimin faturası elime geçmedi.',
    status: 'OPEN',
    createdAt: '2026-08-27T11:12:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
  'support-ticket-provider-new-for-support': {
    fullName: 'Destek Ekibi',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Geçen haftaki talebimin faturası elime geçmedi.',
    status: 'OPEN',
    createdAt: '2026-08-27T11:12:00.000Z',
    requesterName: 'Murat Şahin',
    requesterEmail: 'murat@example.test',
    requesterRoleLabel: 'Hizmet veren',
    ticketUrl: `${ADMIN}/support/tkt_c1a2b3`,
    accountUrl: null,
  },
  'support-ticket-provider-reply': {
    fullName: 'Destek Ekibi',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Ek olarak talep numaram #T-90412.',
    status: 'IN_PROGRESS',
    messageAt: '2026-08-28T09:00:00.000Z',
    requesterName: 'Murat Şahin',
    requesterEmail: 'murat@example.test',
    requesterRoleLabel: 'Hizmet veren',
    ticketUrl: `${ADMIN}/support/tkt_c1a2b3`,
    accountUrl: null,
  },
  'support-ticket-provider-admin-reply': {
    fullName: 'Murat Şahin',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    messageExcerpt: 'Faturanızı yeniden gönderdik, ekte bulabilirsiniz.',
    status: 'IN_PROGRESS',
    messageAt: '2026-08-28T10:00:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
  'support-ticket-provider-status-changed': {
    fullName: 'Murat Şahin',
    ticketReference: 'tkt_c1a2b3',
    ticketSubject: 'Faturam ulaşmadı',
    fromStatus: 'IN_PROGRESS',
    status: 'RESOLVED',
    changedAt: '2026-08-28T12:00:00.000Z',
    ticketUrl: `${WEB}/destek/tkt_c1a2b3`,
    accountUrl: `${WEB}/account/profile`,
  },
};

/**
 * The name a template actually greets with.
 *
 * All but one read `fullName`; `customer-activation` reads the `name` variable
 * its call site has passed since before the design system existed, and keeping
 * that is the whole point of the move — the renderer changed, the payload did
 * not.
 */
function greetedName(template: TransactionalEmailTemplate): string {
  const data = FULL_DATA[template];
  return (data.fullName ?? data.name) as string;
}

/**
 * The two messages that carry the customer's stated timing, and therefore the
 * two that could ever print a storage code at somebody.
 */
const TIMING_TEMPLATES: TransactionalEmailTemplate[] = ['request-received', 'offer-accepted'];

/** Every code the column has ever held, from the one table that names them. */
const URGENCY_CODES = Object.keys(URGENCY_LABELS) as UrgencyCode[];

/** Templates whose call to action carries a single-use token in the URL. */
const TOKEN_TEMPLATES: TransactionalEmailTemplate[] = [
  'password-reset',
  'email-verification',
  'customer-activation',
  'provider-claim',
];

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
    expect(TRANSACTIONAL_EMAIL_TEMPLATES).toHaveLength(26);
    expect(Object.keys(FULL_DATA).sort()).toEqual([...TRANSACTIONAL_EMAIL_TEMPLATES].sort());
  });

  describe.each(TRANSACTIONAL_EMAIL_TEMPLATES)('%s', (template) => {
    it('carries the mandatory salutation and closing in both bodies', () => {
      const { html, text } = render(messageFor(template));
      const fullName = greetedName(template);

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
        // Every link is either a mailto or an absolute URL on one of this
        // deployment's own origins. The operator panel is the second: the two
        // support messages that go to the support inbox link into the queue,
        // which is not served by the web application.
        expect(
          href.startsWith('mailto:') || href.startsWith(WEB) || href.startsWith(ADMIN),
        ).toBe(true);
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
          name: injection,
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
          .filter((key) => key !== 'fullName' && key !== 'name')
          .map((key) => [key, null]),
      );
      const { html } = render(messageFor(template, blanked));

      expect(html).toContain(`Sayın ${greetedName(template)},`);
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
      // The three that moved keep the exact subjects their call sites have
      // always passed, older product spelling and all: re-skinning a message is
      // not licence to rename the product in somebody's inbox.
      'customer-activation': 'TakTic hesabınızı etkinleştirin',
      'provider-claim': 'TakTic hizmet veren başvurunuzu hesabınıza bağlayın',
      'request-expiring': 'Talebiniz için süre dolmak üzere',
      'package-purchase-confirmation': 'Kredi paketiniz hesabınıza yüklendi',
      'support-ticket-created': 'Destek talebiniz alındı — Faturam ulaşmadı',
      'support-ticket-new-for-support': 'Yeni destek talebi — Faturam ulaşmadı',
      'support-ticket-customer-reply': 'Destek talebine müşteri yanıtı — Faturam ulaşmadı',
      'support-ticket-admin-reply': 'Destek talebinize yanıt — Faturam ulaşmadı',
      'support-ticket-status-changed': 'Destek talebiniz çözümlendi — Faturam ulaşmadı',
      'support-ticket-provider-created': 'Destek talebiniz alındı — Faturam ulaşmadı',
      'support-ticket-provider-new-for-support':
        'Yeni destek talebi (hizmet veren) — Faturam ulaşmadı',
      'support-ticket-provider-reply': 'Destek talebine hizmet veren yanıtı — Faturam ulaşmadı',
      'support-ticket-provider-admin-reply': 'Destek talebinize yanıt — Faturam ulaşmadı',
      'support-ticket-provider-status-changed': 'Destek talebiniz çözümlendi — Faturam ulaşmadı',
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

  /**
   * The three that used to render through a plain renderer of their own.
   *
   * The generic cases above already hold them to the design system's shell —
   * the 600px card, the inline styles, the logo and the footer are asserted for
   * every template. What this section adds is the other half of the move: that
   * nothing about the *messages* changed. Same variables, same single-use
   * links, same expiry moments, same editorial constraints.
   */
  describe('the templates that moved onto the design system', () => {
    it('renders the guest activation link inside the card, from the same variables', () => {
      const token = 'ZmFrZS1hY3RpdmF0aW9u';
      const { html, text } = render({
        template: 'customer-activation',
        to: 'alici@example.test',
        subject: transactionalSubject('customer-activation'),
        actionUrl: `${WEB}/activate-customer?token=${token}`,
        data: { name: 'Deniz Yılmaz', expiresAt: '2026-08-29T11:12:00.000Z' },
      });

      // The design shell, not the old bare document.
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain(
        'width:600px;max-width:600px;background-color:#ffffff;border:2px solid #201e1d;',
      );
      expect(html).toContain(`<img src="${ASSETS}/brand/logo-email.png" width="140" alt="TakTick"`);
      expect(html).toContain('destek@example.test');
      expect(html).toContain('TakTick Teknoloji A.Ş.');

      // The name still comes from `name`, and the greeting is the design's one
      // salutation form rather than the old "Merhaba".
      expect(html).toContain('Sayın Deniz Yılmaz,');
      expect(html).not.toContain('Merhaba');

      // The link, once per body and nowhere else — no paste-this-address copy.
      expect(html).toContain(`href="${WEB}/activate-customer?token=${token}"`);
      expect(html.split(token)).toHaveLength(2);
      expect(text.split(token)).toHaveLength(2);

      // The same absolute expiry moment, in the same zone.
      expect(html).toContain('29 Ağustos 2026, 14:12');
      expect(html).toContain('Bu isteği siz yapmadıysanız');
    });

    it('greets a guest customer generically rather than inventing a name', () => {
      const { html } = render({
        template: 'customer-activation',
        to: 'alici@example.test',
        subject: transactionalSubject('customer-activation'),
        actionUrl: `${WEB}/activate-customer?token=abc`,
        data: { name: null, expiresAt: null },
      });

      expect(html).toContain('Sayın Kullanıcı,');
      expect(html).not.toContain('undefined');
      // No expiry row invented for a moment the caller did not supply.
      expect(html).not.toContain('Bağlantı geçerliliği');
    });

    it('keeps the claim invitation silent about the moderation outcome', () => {
      const token = 'ZmFrZS1jbGFpbQ';
      const { html, text } = render({
        template: 'provider-claim',
        to: 'basvuru@example.test',
        subject: transactionalSubject('provider-claim'),
        actionUrl: `${WEB}/claim-provider?token=${token}`,
        data: {
          fullName: 'Murat Şahin',
          businessName: 'Şahin Isı Sistemleri',
          expiresAt: '2026-08-29T11:12:00.000Z',
        },
      });

      expect(html).toContain('Sayın Murat Şahin,');
      expect(html).toContain('Şahin Isı Sistemleri');
      expect(html).toContain(`href="${WEB}/claim-provider?token=${token}"`);
      expect(html.split(token)).toHaveLength(2);
      expect(text.split(token)).toHaveLength(2);
      expect(html).toContain('29 Ağustos 2026, 14:12');

      // The sentence that keeps a claim from reading as an approval.
      expect(html).toContain('yalnızca başvurunun sahipliğini doğrular');
      expect(html).not.toContain('onaylandı');
      expect(html).not.toContain('kabul edildi');
    });

    it('falls back to the business when a guest application has no contact name', () => {
      const { html } = render({
        template: 'provider-claim',
        to: 'basvuru@example.test',
        subject: transactionalSubject('provider-claim'),
        actionUrl: `${WEB}/claim-provider?token=abc`,
        data: { fullName: null, businessName: 'Şahin Isı Sistemleri', expiresAt: null },
      });

      expect(html).toContain('Sayın Şahin Isı Sistemleri,');
      expect(html).not.toContain('Sayın Kullanıcı,');
    });

    it('states the reminder without a link, a verification claim or an offer promise', () => {
      const { html } = render({
        template: 'request-expiring',
        to: 'alici@example.test',
        subject: transactionalSubject('request-expiring'),
        data: FULL_DATA['request-expiring'],
      });

      expect(html).toContain('Sayın Deniz Yılmaz,');
      expect(html).toContain('Kombi Servisi kategorisindeki #T-90412 numaralı talebiniz hâlâ açık.');
      expect(html).toContain('14 gün');
      expect(html).toContain('7 gün');
      expect(html).toContain('5 Eylül 2026, 14:12');

      // No call to action: this message has never linked anywhere, and the
      // design drops a button it has no destination for.
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
      expect(hrefs.every((href) => href.startsWith('mailto:'))).toBe(true);

      // The two things it must never say.
      expect(html).not.toContain('doğrulandı');
      expect(html).not.toContain('teklifler yolda');
    });
  });

  describe('package-purchase-confirmation', () => {
    it('states what was bought, what it cost and what the balance gained', () => {
      const { html, text } = render(messageFor('package-purchase-confirmation'));

      expect(html).toContain('Kredi paketiniz hesabınıza yüklendi');
      expect(html).toContain('Başlangıç Paketi');
      expect(html).toContain('30 kredi');
      expect(html).toContain('499 ₺');
      expect(html).toContain('#P-10023');
      expect(html).toContain('27 Ağustos 2026, 14:12');
      expect(html).toContain(`href="${WEB}/providers/p1/credits"`);
      expect(text).toContain('Ödenen tutar: 499 ₺');
    });

    it('names a currency this product has no sign for rather than guessing one', () => {
      const { html } = render(
        messageFor('package-purchase-confirmation', {
          priceAmountMinor: '49900',
          currency: 'USD',
        }),
      );

      expect(html).toContain('499 USD');
      expect(html).not.toContain('499 ₺');
    });

    it('drops the amount entirely when the currency is missing', () => {
      const { html } = render(
        messageFor('package-purchase-confirmation', { currency: null }),
      );

      // An amount with no currency is not a fact a receipt may state.
      expect(html).not.toContain('499');
      expect(html).not.toContain('Ödenen tutar');
      // The rest of the receipt still stands.
      expect(html).toContain('Başlangıç Paketi');
      expect(html).toContain('30 kredi');
    });

    it('carries nothing from the payment provider or the operator', () => {
      const { html, text } = render(
        messageFor('package-purchase-confirmation', {
          // None of these are variables this template reads. The point is that
          // supplying them changes nothing, so a careless future caller cannot
          // leak them into a receipt.
          paymentReference: 'corr-token-abc123',
          providerOrderId: 'ls-order-99',
          adminNote: 'İç not: elle doğrulandı',
          eventName: 'order_created',
          apiKey: 'lemon-secret-key',
        }),
      );

      for (const body of [html, text]) {
        expect(body).not.toContain('corr-token-abc123');
        expect(body).not.toContain('ls-order-99');
        expect(body).not.toContain('İç not');
        expect(body).not.toContain('order_created');
        expect(body).not.toContain('lemon-secret-key');
      }
    });
  });

  /**
   * The support-ticket messages: five per desk, ten in all.
   *
   * Four of them go to an operator mailbox and six to the person who opened the
   * ticket, and the line between those two sets is the point of this section —
   * not the line between the two desks. A requester's copy must carry the
   * ticket, the answer and nothing about who inside the company wrote it,
   * whichever side of the marketplace they are on; an operator's copy may carry
   * the requester's identity, because an operator already sees it on the queue
   * screen this message links to.
   *
   * Every case below runs over both desks. That is deliberate: the hizmet veren
   * templates were written by copying the hizmet alan ones, which is exactly
   * the situation in which a rule quietly holds for one half of a family and
   * not the other.
   */
  describe('support tickets', () => {
    const REQUESTER_TEMPLATES: TransactionalEmailTemplate[] = [
      'support-ticket-created',
      'support-ticket-admin-reply',
      'support-ticket-status-changed',
      'support-ticket-provider-created',
      'support-ticket-provider-admin-reply',
      'support-ticket-provider-status-changed',
    ];

    const SUPPORT_TEMPLATES: TransactionalEmailTemplate[] = [
      'support-ticket-new-for-support',
      'support-ticket-customer-reply',
      'support-ticket-provider-new-for-support',
      'support-ticket-provider-reply',
    ];

    /** Every code the status column can hold, as the enum spells them. */
    const STATUS_CODES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

    it.each([...REQUESTER_TEMPLATES, ...SUPPORT_TEMPLATES])(
      '%s names the ticket, its subject and the last message',
      (template) => {
        const { html, text } = render(messageFor(template));

        for (const body of [html, text]) {
          expect(body).toContain('tkt_c1a2b3');
          expect(body).toContain('Faturam ulaşmadı');
          expect(body).toContain(FULL_DATA[template].messageExcerpt ?? 'Faturam ulaşmadı');
        }
      },
    );

    it.each(REQUESTER_TEMPLATES)('%s links its reader to their own ticket', (template) => {
      const { html, text } = render(messageFor(template));

      expect(html).toContain(`${WEB}/destek/tkt_c1a2b3`);
      expect(text).toContain(`${WEB}/destek/tkt_c1a2b3`);
      // Never the operator panel: neither a hizmet alan nor a hizmet veren can
      // open it, and being sent there says the platform confused the two
      // audiences.
      expect(html).not.toContain(ADMIN);
      expect(text).not.toContain(ADMIN);
    });

    it.each(SUPPORT_TEMPLATES)('%s links the operator to the queue entry', (template) => {
      const { html, text } = render(messageFor(template));

      expect(html).toContain(`${ADMIN}/support/tkt_c1a2b3`);
      expect(text).toContain(`${ADMIN}/support/tkt_c1a2b3`);
    });

    it.each([...REQUESTER_TEMPLATES, ...SUPPORT_TEMPLATES])(
      '%s prints the status in Turkish and never the storage code',
      (template) => {
        for (const status of STATUS_CODES) {
          const { html, text } = render(messageFor(template, { status, fromStatus: 'OPEN' }));

          for (const body of [html, text]) {
            for (const code of STATUS_CODES) {
              expect(body).not.toContain(code);
            }
          }

          expect(html).toContain(
            { OPEN: 'Açık', IN_PROGRESS: 'İnceleniyor', RESOLVED: 'Çözümlendi', CLOSED: 'Kapatıldı' }[
              status
            ] as string,
          );
        }
      },
    );

    it('drops the status row entirely for a code this build does not know', () => {
      const { html, text } = render(
        messageFor('support-ticket-status-changed', { status: 'ESCALATED', fromStatus: 'PARKED' }),
      );

      for (const body of [html, text]) {
        expect(body).not.toContain('ESCALATED');
        expect(body).not.toContain('PARKED');
      }
    });

    it.each(REQUESTER_TEMPLATES)('%s carries nothing about the operator who answered', (template) => {
      const { html, text } = render(
        messageFor(template, {
          // Every one of these is a field an operator-facing payload could
          // plausibly grow. None of them may reach a customer's inbox, and a
          // template that started reading one would fail here rather than in
          // somebody's mail client.
          adminEmail: 'operator@taktick.com.tr',
          adminName: 'Operatör Ayşe',
          internalNote: 'İç not: müşteri ısrarcı',
          operationalReason: 'SLA aşımı nedeniyle kapatıldı',
          // The address field the operator's own copies carry. A requester
          // template that started reading it would be printing an e-mail
          // address into a message that had no business holding one.
          requesterEmail: 'sizinle@example.test',
        }),
      );

      for (const body of [html, text]) {
        expect(body).not.toContain('operator@taktick.com.tr');
        expect(body).not.toContain('Operatör Ayşe');
        expect(body).not.toContain('İç not');
        expect(body).not.toContain('SLA');
        expect(body).not.toContain('sizinle@example.test');
      }
    });

    it.each(SUPPORT_TEMPLATES)('%s carries the person an operator has to answer', (template) => {
      const { html, text } = render(messageFor(template));
      const data = FULL_DATA[template];

      for (const body of [html, text]) {
        expect(body).toContain(data.requesterName as string);
        expect(body).toContain(data.requesterEmail as string);
        // And which desk they are on, so a shared mailbox can be triaged
        // without opening the message.
        expect(body).toContain(data.requesterRoleLabel as string);
      }
    });

    /**
     * The two halves of the family must not be able to swap audiences.
     *
     * A hizmet veren's copy of an answer is written by copying the hizmet
     * alan's, and the copy that matters is the audience strip: it is the one
     * line that says out loud which panel a forwarded message belongs to, and
     * the one thing a copy-paste is most likely to leave pointing at the
     * original.
     */
    it('marks each desk with its own audience strip', () => {
      for (const template of [
        'support-ticket-created',
        'support-ticket-admin-reply',
        'support-ticket-status-changed',
      ] as TransactionalEmailTemplate[]) {
        expect(render(messageFor(template)).html).toContain('HİZMET ALAN');
      }

      for (const template of [
        'support-ticket-provider-created',
        'support-ticket-provider-admin-reply',
        'support-ticket-provider-status-changed',
      ] as TransactionalEmailTemplate[]) {
        const { html } = render(messageFor(template));
        expect(html).toContain('HİZMET VEREN');
        expect(html).not.toContain('HİZMET ALAN');
      }
    });

    it.each([...REQUESTER_TEMPLATES, ...SUPPORT_TEMPLATES])(
      '%s promises no response time and no service level',
      (template) => {
        const { html, text } = render(messageFor(template));

        for (const body of [html, text]) {
          expect(body).not.toMatch(/\d+\s*(saat|iş günü|gün) içinde/);
          expect(body).not.toContain('en kısa sürede');
          expect(body).not.toContain('SLA');
          expect(body).not.toContain('garanti');
        }
      },
    );

    it('says what changed, in both directions, on a status message', () => {
      const { html } = render(
        messageFor('support-ticket-status-changed', {
          fromStatus: 'IN_PROGRESS',
          status: 'RESOLVED',
        }),
      );

      expect(html).toContain('İnceleniyor');
      expect(html).toContain('Çözümlendi');
    });

    it('states a subject that follows the ticket, however long the ticket subject is', () => {
      const long = 'ç'.repeat(200);

      expect(transactionalSubject('support-ticket-created', { ticketSubject: long }).length)
        .toBeLessThanOrEqual(120);
    });
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
