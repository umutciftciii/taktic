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
  developmentBranding,
  readDeprecatedEnvBranding,
} from '../src/modules/notifications/email-branding.config';

/**
 * What is still *deployment* configuration, and what is no longer.
 *
 * The public base URL is: every link the platform mails is built from it, it is
 * a fact about where the deployment lives, and a wrong one is a security
 * problem rather than a cosmetic one. It stays boot-enforced, and the trigger is
 * the transport rather than NODE_ENV — a process wired to Resend puts messages
 * in strangers' inboxes whatever it calls itself.
 *
 * The company's legal name, support address and postal address are not. They
 * are business facts an operator maintains from the admin panel
 * (CompanySettings), so nothing here may refuse to boot over them: taking a
 * marketplace offline because a footer is unfinished is a worse failure than
 * the one it prevents. What replaces the boot check is a send-time refusal —
 * see email-branding-settings.spec.ts, which is where "a real transport never
 * mails a placeholder footer" is now proven end to end.
 *
 * The two variables below still work as a fallback for a deployment that had
 * them before the panel existed. They are deprecated, never required, and a row
 * in CompanySettings wins over them.
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

describe('deprecated e-mail branding variables', () => {
  it('are read when they are set, so an existing deployment keeps its footer', () => {
    process.env.SUPPORT_EMAIL = 'Destek@Taktick.Example';
    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';
    process.env.COMPANY_POSTAL_ADDRESS = 'Bir Cadde No:1, Çankaya/Ankara';

    expect(readDeprecatedEnvBranding()).toEqual({
      // Normalised the way an address is stored everywhere else here.
      supportEmail: 'destek@taktick.example',
      legalName: 'TakTick Teknoloji A.Ş.',
      postalAddress: 'Bir Cadde No:1, Çankaya/Ankara',
    });
  });

  it('are null when unset — absent is not misconfigured', () => {
    expect(readDeprecatedEnvBranding()).toEqual({
      supportEmail: null,
      legalName: null,
      postalAddress: null,
    });
  });

  it('treat a blank value as absent rather than as an empty footer', () => {
    process.env.SUPPORT_EMAIL = '   ';
    process.env.COMPANY_LEGAL_NAME = '';

    const values = readDeprecatedEnvBranding();
    expect(values.supportEmail).toBeNull();
    expect(values.legalName).toBeNull();
  });

  it('never stop the process from booting, delivering transport or not', () => {
    // The rule this replaces refused to start without SUPPORT_EMAIL and
    // COMPANY_LEGAL_NAME. It no longer does — with Resend selected, with
    // NODE_ENV=production, and with nothing set at all.
    expect(() => assertEmailBrandingConfig()).not.toThrow();

    process.env.EMAIL_TRANSPORT = 'resend';
    process.env.RESEND_API_KEY = 're_TESTKEY_not_a_real_credential';
    process.env.EMAIL_FROM = 'Taktick <noreply@notify.taktick.com.tr>';
    expect(() => assertEmailBrandingConfig()).not.toThrow();

    process.env.NODE_ENV = 'production';
    expect(() => assertEmailBrandingConfig()).not.toThrow();
  });

  it('still refuse a support value that is not an e-mail address at all', () => {
    // Deprecated is not the same as ignored. Silently dropping this would leave
    // an operator convinced they had configured something.
    process.env.SUPPORT_EMAIL = 'destek sayfası';
    expect(() => readDeprecatedEnvBranding()).toThrowError(/must be a plain e-mail address/);
    expect(() => assertEmailBrandingConfig()).toThrowError(/must be a plain e-mail address/);
  });
});

describe('the development footer', () => {
  it('is the unroutable placeholder a preview should show', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    const branding = developmentBranding();

    expect(branding.supportEmail).toBe(DEVELOPMENT_SUPPORT_EMAIL);
    expect(branding.companyName).toBe(DEVELOPMENT_COMPANY_NAME);
    // No invented street address: the footer line is dropped instead.
    expect(branding.companyAddress).toBeNull();
    expect(branding.logoUrl).toBe('https://web.example.test/brand/logo-email.png');
  });
});
