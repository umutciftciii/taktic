import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_WEB_BASE_URL,
  assertPublicUrlConfig,
  publicAssetUrl,
  publicWebUrl,
  readEmailAssetBaseUrl,
  readPublicWebBaseUrl,
} from '../src/common/public-urls';
import { passwordResetUrl } from '../src/common/web-routes';
import {
  DEVELOPMENT_COMPANY_NAME,
  DEVELOPMENT_SUPPORT_EMAIL,
  assertEmailBrandingConfig,
  readEmailBranding,
} from '../src/modules/notifications/email-branding.config';

/**
 * What the deployment has to declare before it may send anything.
 *
 * The trigger is the transport, not NODE_ENV. A process wired to Resend puts
 * messages in strangers' inboxes whatever it calls itself, and it did: a real,
 * DKIM-signed e-mail went out from a process running as "development" with a
 * footer telling the customer to write to `destek@example.test`. NODE_ENV
 * describes how the process was started; `EMAIL_TRANSPORT=resend` describes
 * whether anybody receives what it composes.
 *
 * So the matrix below is two-dimensional: with a non-delivering transport the
 * safe, obviously-fake defaults stand, and with a delivering one — or under
 * production, kept as a second trigger — every branding value has to be real or
 * the process does not start.
 */

const TRACKED = [
  'WEB_APP_URL',
  'WEB_ORIGIN',
  'NEXT_PUBLIC_WEB_URL',
  'EMAIL_ASSET_BASE_URL',
  'SUPPORT_EMAIL',
  'COMPANY_LEGAL_NAME',
  'COMPANY_POSTAL_ADDRESS',
  'NODE_ENV',
  'EMAIL_TRANSPORT',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  'NOTIFICATION_OUTBOX_DIR',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TRACKED.map((name) => [name, process.env[name]]));
  for (const name of TRACKED) {
    delete process.env[name];
  }
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const name of TRACKED) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

/**
 * A syntactically valid key that was never issued. `readResendConfig` only
 * checks the shape, and nothing in this file performs a send.
 */
const PLACEHOLDER_KEY = 're_TESTKEY_not_a_real_credential';

/** Wires the process to the one transport that reaches a stranger's inbox. */
function selectDeliveringTransport() {
  process.env.EMAIL_TRANSPORT = 'resend';
  process.env.RESEND_API_KEY = PLACEHOLDER_KEY;
  process.env.EMAIL_FROM = 'Taktick <noreply@notify.taktick.com.tr>';
}

describe('public base URL', () => {
  it('falls back to localhost outside production', () => {
    expect(readPublicWebBaseUrl()).toBe(DEFAULT_PUBLIC_WEB_BASE_URL);
    expect(() => assertPublicUrlConfig()).not.toThrow();
  });

  it('is mandatory in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => readPublicWebBaseUrl()).toThrowError(/WEB_APP_URL is required/);
  });

  it('is mandatory as soon as a delivering transport is selected', () => {
    // The reported failure, in one case: NODE_ENV is not production, and mail
    // still leaves the building. Links built from the localhost fallback would
    // be opened from the recipient's phone.
    selectDeliveringTransport();
    expect(() => readPublicWebBaseUrl()).toThrowError(/WEB_APP_URL is required/);
    expect(() => assertPublicUrlConfig()).toThrowError(/WEB_APP_URL is required/);

    process.env.WEB_APP_URL = 'https://web.example.test';
    expect(readPublicWebBaseUrl()).toBe('https://web.example.test');
  });

  it('refuses loopback once a delivering transport is selected', () => {
    selectDeliveringTransport();
    process.env.WEB_APP_URL = 'http://localhost:3000';
    expect(() => readPublicWebBaseUrl()).toThrowError(/must not point at loopback/);
  });

  it('keeps the localhost fallback for the transports that deliver nothing', () => {
    for (const transport of ['console', 'file-outbox'] as const) {
      process.env.EMAIL_TRANSPORT = transport;
      if (transport === 'file-outbox') {
        process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktick-e2e-outbox';
      } else {
        delete process.env.NOTIFICATION_OUTBOX_DIR;
      }

      expect(readPublicWebBaseUrl()).toBe(DEFAULT_PUBLIC_WEB_BASE_URL);
      expect(() => assertPublicUrlConfig()).not.toThrow();
    }
  });

  it('accepts the historical variable names', () => {
    process.env.WEB_ORIGIN = 'https://web.example.test';
    expect(readPublicWebBaseUrl()).toBe('https://web.example.test');
  });

  it('refuses a value that is not an absolute origin', () => {
    process.env.WEB_APP_URL = '/uygulama';
    expect(() => readPublicWebBaseUrl()).toThrowError(/must be a valid absolute URL/);

    process.env.WEB_APP_URL = 'https://web.example.test/uygulama';
    expect(() => readPublicWebBaseUrl()).toThrowError(/without a path, query or fragment/);
  });

  it('requires https unless the host is loopback', () => {
    process.env.WEB_APP_URL = 'http://web.example.test';
    expect(() => readPublicWebBaseUrl()).toThrowError(/must use https/);

    process.env.WEB_APP_URL = 'http://localhost:3000';
    expect(readPublicWebBaseUrl()).toBe('http://localhost:3000');
  });

  it('refuses loopback in production, where the links are opened elsewhere', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_APP_URL = 'http://localhost:3000';
    expect(() => readPublicWebBaseUrl()).toThrowError(/must not point at loopback/);
  });

  it('serves assets from the web application unless a CDN is named', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    expect(readEmailAssetBaseUrl()).toBe('https://web.example.test');
    expect(publicAssetUrl('/brand/logo-email.png')).toBe(
      'https://web.example.test/brand/logo-email.png',
    );

    process.env.EMAIL_ASSET_BASE_URL = 'https://cdn.example.test';
    expect(publicAssetUrl('/brand/logo-email.png')).toBe(
      'https://cdn.example.test/brand/logo-email.png',
    );
  });

  it('puts a token in the query rather than in the path it was pasted into', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    const url = passwordResetUrl('abc/def?x=1&y=2#z');

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://web.example.test');
    expect(parsed.pathname).toBe('/sifre-sifirla');
    // Round-trips exactly, and nothing escaped into another parameter.
    expect(parsed.searchParams.get('token')).toBe('abc/def?x=1&y=2#z');
    expect([...parsed.searchParams.keys()]).toEqual(['token']);
  });

  it('joins a rooted path onto the origin', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    expect(publicWebUrl('/requests/abc/offers')).toBe('https://web.example.test/requests/abc/offers');
  });
});

describe('e-mail branding', () => {
  it('uses unroutable placeholders outside production', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    const branding = readEmailBranding();

    expect(branding.supportEmail).toBe(DEVELOPMENT_SUPPORT_EMAIL);
    expect(branding.companyName).toBe(DEVELOPMENT_COMPANY_NAME);
    // No invented street address: the footer line is dropped instead.
    expect(branding.companyAddress).toBeNull();
    expect(() => assertEmailBrandingConfig()).not.toThrow();
  });

  it('demands a real support address and company name in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_APP_URL = 'https://web.example.test';

    expect(() => readEmailBranding()).toThrowError(/SUPPORT_EMAIL is required/);

    process.env.SUPPORT_EMAIL = 'destek@taktick.example';
    expect(() => readEmailBranding()).toThrowError(/COMPANY_LEGAL_NAME is required/);

    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';
    expect(() => readEmailBranding()).not.toThrow();
  });

  it('demands them as soon as a delivering transport is selected', () => {
    // This is the case that shipped a footer reading "destek@example.test" to a
    // real customer: Resend configured, NODE_ENV left at "development".
    selectDeliveringTransport();
    process.env.WEB_APP_URL = 'https://web.example.test';

    expect(() => readEmailBranding()).toThrowError(/SUPPORT_EMAIL is required/);
    expect(() => assertEmailBrandingConfig()).toThrowError(/SUPPORT_EMAIL is required/);

    process.env.SUPPORT_EMAIL = 'destek@taktick.example';
    expect(() => readEmailBranding()).toThrowError(/COMPANY_LEGAL_NAME is required/);

    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';
    const branding = readEmailBranding();
    expect(branding.supportEmail).toBe('destek@taktick.example');
    expect(branding.companyName).toBe('TakTick Teknoloji A.Ş.');
  });

  it('never lets the placeholder reach a delivering transport', () => {
    selectDeliveringTransport();
    process.env.WEB_APP_URL = 'https://web.example.test';
    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';

    // Spelling the placeholder out explicitly is not a way round the rule: it
    // is refused whether it was defaulted or configured by hand.
    process.env.SUPPORT_EMAIL = DEVELOPMENT_SUPPORT_EMAIL;
    expect(() => assertEmailBrandingConfig()).toThrowError(
      /SUPPORT_EMAIL must not be the development placeholder/,
    );

    process.env.SUPPORT_EMAIL = 'destek@taktick.example';
    process.env.COMPANY_LEGAL_NAME = DEVELOPMENT_COMPANY_NAME;
    expect(() => assertEmailBrandingConfig()).toThrowError(
      /COMPANY_LEGAL_NAME must not be the development placeholder/,
    );
  });

  it('keeps the placeholders for the transports that deliver nothing', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';

    for (const transport of ['console', 'file-outbox'] as const) {
      process.env.EMAIL_TRANSPORT = transport;
      if (transport === 'file-outbox') {
        process.env.NOTIFICATION_OUTBOX_DIR = '/tmp/taktick-e2e-outbox';
      } else {
        delete process.env.NOTIFICATION_OUTBOX_DIR;
      }

      const branding = readEmailBranding();
      expect(branding.supportEmail).toBe(DEVELOPMENT_SUPPORT_EMAIL);
      expect(branding.companyName).toBe(DEVELOPMENT_COMPANY_NAME);
      expect(() => assertEmailBrandingConfig()).not.toThrow();
    }
  });

  it('does not derive the support address from the sender', () => {
    // The two are different facts. EMAIL_FROM is a DKIM-signed, no-reply
    // mailbox on the verified domain; the support address is where a customer's
    // reply is actually read, and it has to be stated.
    selectDeliveringTransport();
    process.env.WEB_APP_URL = 'https://web.example.test';
    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';

    expect(() => readEmailBranding()).toThrowError(/SUPPORT_EMAIL is required/);

    process.env.SUPPORT_EMAIL = 'destek@taktick.example';
    expect(readEmailBranding().supportEmail).toBe('destek@taktick.example');
    expect(readEmailBranding().supportEmail).not.toContain('noreply');
  });

  it('refuses a support value that is not an e-mail address', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    process.env.SUPPORT_EMAIL = 'destek sayfası';
    expect(() => readEmailBranding()).toThrowError(/must be a plain e-mail address/);
  });
});
