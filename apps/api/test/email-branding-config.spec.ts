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
 * The rule under test is the same one every other configuration module in this
 * codebase follows: development gets a safe, obviously-fake default, production
 * gets a boot failure. A production process that quietly mails links to
 * localhost, or a footer telling customers to write to an example address, is a
 * failure discovered from somebody else's inbox.
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

describe('public base URL', () => {
  it('falls back to localhost outside production', () => {
    expect(readPublicWebBaseUrl()).toBe(DEFAULT_PUBLIC_WEB_BASE_URL);
    expect(() => assertPublicUrlConfig()).not.toThrow();
  });

  it('is mandatory in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => readPublicWebBaseUrl()).toThrowError(/WEB_APP_URL is required in production/);
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
    expect(() => readPublicWebBaseUrl()).toThrowError(/must not point at loopback in production/);
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

    expect(() => readEmailBranding()).toThrowError(/SUPPORT_EMAIL is required in production/);

    process.env.SUPPORT_EMAIL = 'destek@taktick.example';
    expect(() => readEmailBranding()).toThrowError(/COMPANY_LEGAL_NAME is required in production/);

    process.env.COMPANY_LEGAL_NAME = 'TakTick Teknoloji A.Ş.';
    expect(() => readEmailBranding()).not.toThrow();
  });

  it('refuses a support value that is not an e-mail address', () => {
    process.env.WEB_APP_URL = 'https://web.example.test';
    process.env.SUPPORT_EMAIL = 'destek sayfası';
    expect(() => readEmailBranding()).toThrowError(/must be a plain e-mail address/);
  });
});
