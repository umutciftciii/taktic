import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_WEB_BASE_URL,
  isPublicUrlDeliverable,
  publicAssetUrl,
  publicUrlIssues,
  publicWebUrl,
  readEmailAssetBaseUrl,
  readPublicWebBaseUrl,
  resolveEmailAssetBaseUrl,
  resolvePublicWebBaseUrl,
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
  /**
   * Resolution never throws, and never stops the process.
   *
   * That is the correction this block exists for. These rules used to run at
   * boot and refuse to start the API, which meant a base URL that was merely
   * unusable *in an e-mail* also took down authentication, the admin panel and
   * every request and offer flow. The verdict is still exactly as strict — the
   * cases below pin each way a base can be unusable — but it is now a value the
   * delivering transport reads per send, not an exception at startup.
   */
  it('resolves to the localhost fallback when nothing is configured', () => {
    expect(readPublicWebBaseUrl()).toBe(DEFAULT_PUBLIC_WEB_BASE_URL);
    // Usable for building a link, and still not something to mail anybody.
    expect(resolvePublicWebBaseUrl().issue).toBe('MISSING');
    expect(isPublicUrlDeliverable()).toBe(false);
  });

  it('never throws, whatever the value and whatever the transport', () => {
    // The exact matrix that used to kill the process at boot.
    for (const value of [undefined, 'http://localhost:3000', '/uygulama', 'https://web.example.test/app', 'http://web.example.test']) {
      for (const transport of ['console', 'resend'] as const) {
        delete process.env.WEB_APP_URL;
        if (value !== undefined) process.env.WEB_APP_URL = value;
        process.env.EMAIL_TRANSPORT = transport;
        if (transport === 'resend') {
          process.env.RESEND_API_KEY = PLACEHOLDER_KEY;
          process.env.EMAIL_FROM = 'Taktick <noreply@notify.taktick.com.tr>';
        }

        expect(() => readPublicWebBaseUrl()).not.toThrow();
        expect(() => readEmailAssetBaseUrl()).not.toThrow();
        expect(() => publicWebUrl('/requests/abc/offers')).not.toThrow();
        expect(() => publicAssetUrl('/brand/logo-email.png')).not.toThrow();
        // Whatever it resolved to, a link can be built from it.
        expect(() => new URL(readPublicWebBaseUrl())).not.toThrow();
      }
    }
  });

  it('names each way a base cannot be put in front of a recipient', () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'MISSING'],
      ['not a url', 'MALFORMED'],
      ['https://web.example.test/uygulama', 'NOT_AN_ORIGIN'],
      ['https://web.example.test/?a=1', 'NOT_AN_ORIGIN'],
      ['http://localhost:3000', 'LOOPBACK'],
      ['http://127.0.0.1:3000', 'LOOPBACK'],
      // Loopback is reported as loopback rather than as plain http: it is the
      // more specific truth, and it is what the operator has to change.
      ['http://web.example.test', 'INSECURE'],
    ];

    for (const [value, issue] of cases) {
      delete process.env.WEB_APP_URL;
      if (value !== undefined) process.env.WEB_APP_URL = value;

      expect(resolvePublicWebBaseUrl().issue).toBe(issue);
      expect(isPublicUrlDeliverable()).toBe(false);
    }
  });

  it('is deliverable only for a plain https origin', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';

    expect(resolvePublicWebBaseUrl().issue).toBeNull();
    expect(isPublicUrlDeliverable()).toBe(true);
    expect(publicUrlIssues()).toEqual([]);
    expect(readPublicWebBaseUrl()).toBe('https://web.example.test');
  });

  it('names the variable the value actually came from', () => {
    // This used to always say WEB_APP_URL, which sent an operator to edit a
    // variable that was not set while WEB_ORIGIN was the one at fault.
    process.env.WEB_ORIGIN = 'http://localhost:3000';
    expect(resolvePublicWebBaseUrl()).toMatchObject({ source: 'WEB_ORIGIN', issue: 'LOOPBACK' });
    expect(publicUrlIssues()).toEqual([{ source: 'WEB_ORIGIN', issue: 'LOOPBACK' }]);

    delete process.env.WEB_ORIGIN;
    process.env.WEB_APP_URL = 'http://localhost:3000';
    expect(resolvePublicWebBaseUrl()).toMatchObject({ source: 'WEB_APP_URL', issue: 'LOOPBACK' });
  });

  it('accepts the historical variable names', () => {
    process.env.WEB_ORIGIN = 'https://web.example.test';
    expect(readPublicWebBaseUrl()).toBe('https://web.example.test');
    expect(isPublicUrlDeliverable()).toBe(true);
  });

  it('judges the asset base on its own, and blocks delivery when it is unusable', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    process.env.EMAIL_ASSET_BASE_URL = 'http://localhost:9000';

    // The page links are fine; the logo would point at the recipient's machine.
    expect(resolvePublicWebBaseUrl().issue).toBeNull();
    expect(resolveEmailAssetBaseUrl()).toMatchObject({
      source: 'EMAIL_ASSET_BASE_URL',
      issue: 'LOOPBACK',
    });
    expect(isPublicUrlDeliverable()).toBe(false);
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
    expect(isPublicUrlDeliverable()).toBe(true);
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
