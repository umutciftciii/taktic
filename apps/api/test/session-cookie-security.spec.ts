import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSessionCookie, sessionCookie } from '../src/modules/auth/cookie';
import { sessionCookieIsSecure } from '../src/common/cookie-security';

/**
 * When the session cookie is `Secure`, decided without a database and without a
 * browser.
 *
 * The defect this pins: `Secure` came from `process.env.NODE_ENV ===
 * 'production'`. The staging deployment is a public https origin started with
 * `NODE_ENV=development`, so it issued session cookies with no `Secure` at all —
 * a session id that any stripped-TLS request would carry in cleartext, on the
 * one deployment reachable from the internet. Turning `NODE_ENV` up is not the
 * fix either: on the plain-HTTP local stack that marks the cookie `Secure` and a
 * browser refuses to keep it, which is the Safari failure the web app's
 * session-cookie.ts documents, arriving from the other side.
 *
 * So both configurations are asserted here, side by side, and neither is allowed
 * to be reached through `NODE_ENV`: the staging shape says `Secure` **while
 * NODE_ENV is development**, and the local shape says nothing **while NODE_ENV
 * is production**. A regression that reintroduces the old rule fails both.
 *
 * A pure unit test on purpose. The end-to-end suite speaks plain HTTP and
 * therefore cannot witness the https direction at all; this is the only place
 * the production answer can be pinned without a certificate.
 */

/** Every variable that can name the public web origin, plus the old input. */
const POLICY_VARIABLES = [
  'NODE_ENV',
  'WEB_APP_URL',
  'WEB_ORIGIN',
  'NEXT_PUBLIC_WEB_URL',
] as const;

/** A staging-shaped deployment: a real https origin, running as development. */
const PUBLIC_HTTPS = 'https://taktick.example';

let original: Record<string, string | undefined>;

beforeEach(() => {
  original = Object.fromEntries(POLICY_VARIABLES.map((key) => [key, process.env[key]]));
  for (const key of POLICY_VARIABLES) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** The `Secure` attribute, as the valueless flag it is — never a substring. */
function isSecure(header: string): boolean {
  return header.split(';').some((attribute) => attribute.trim().toLowerCase() === 'secure');
}

/** The three headers the policy has to answer identically. */
function allCookies() {
  return {
    set: sessionCookie('session-id', new Date(Date.now() + 60_000), false),
    remembered: sessionCookie('session-id', new Date(Date.now() + 60_000), true),
    cleared: clearSessionCookie(),
  };
}

describe('a public HTTPS deployment', () => {
  it('marks the cookie Secure even under NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    process.env.WEB_APP_URL = PUBLIC_HTTPS;

    expect(sessionCookieIsSecure()).toBe(true);

    const { set, remembered, cleared } = allCookies();
    expect(isSecure(set)).toBe(true);
    expect(isSecure(remembered)).toBe(true);
    // The clearing cookie takes the same decision from the same place. The two
    // used to share a serializer by accident; now they share a policy.
    expect(isSecure(cleared)).toBe(true);
  });

  it('reads the origin from any of the three names an existing deployment may use', () => {
    process.env.NODE_ENV = 'development';

    for (const name of ['WEB_APP_URL', 'WEB_ORIGIN', 'NEXT_PUBLIC_WEB_URL'] as const) {
      for (const key of POLICY_VARIABLES) {
        if (key !== 'NODE_ENV') delete process.env[key];
      }
      process.env[name] = PUBLIC_HTTPS;

      expect(sessionCookieIsSecure(), `${name} must decide the cookie`).toBe(true);
    }
  });
});

describe('local HTTP development', () => {
  it('leaves Secure off, even under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'http://localhost:3000';

    expect(sessionCookieIsSecure()).toBe(false);

    const { set, remembered, cleared } = allCookies();
    expect(isSecure(set)).toBe(false);
    expect(isSecure(remembered)).toBe(false);
    expect(isSecure(cleared)).toBe(false);
  });

  it('leaves Secure off for the loopback spellings and for an unset origin', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      // A plain-HTTP host that is not loopback is still plain HTTP: a cookie
      // marked Secure would simply never come back.
      'http://taktick.example',
    ]) {
      process.env.WEB_ORIGIN = origin;
      expect(sessionCookieIsSecure(), `${origin} must not require Secure`).toBe(false);
    }

    // Nothing configured at all — the suite's own shape, and a fresh checkout's.
    delete process.env.WEB_ORIGIN;
    expect(sessionCookieIsSecure()).toBe(false);
  });

  it('is not decided by a value that cannot name an origin', () => {
    // A malformed setting falls back to the local default rather than to
    // "Secure": a deployment that cannot say where it lives must not be handed
    // a cookie its browser will drop.
    process.env.WEB_APP_URL = 'not a url';
    expect(sessionCookieIsSecure()).toBe(false);
  });
});

describe('the attributes the policy does not touch', () => {
  it('keeps HttpOnly, SameSite=Lax, host-only scope and Path=/ in both configurations', () => {
    for (const origin of [PUBLIC_HTTPS, 'http://localhost:3000']) {
      process.env.WEB_APP_URL = origin;
      const { set, remembered, cleared } = allCookies();

      for (const header of [set, remembered, cleared]) {
        expect(header).toContain('HttpOnly');
        expect(header).toContain('SameSite=Lax');
        expect(header).toContain('Path=/');
        // Host-only: no Domain attribute means the cookie never widens to a
        // parent domain, and nothing here has any business adding one.
        expect(header.toLowerCase()).not.toContain('domain=');
      }

      // "Beni hatırla" is still the only thing that makes the cookie outlive
      // the browser, on either transport.
      expect(set).not.toContain('Max-Age');
      expect(set).not.toContain('Expires');
      expect(remembered).toContain('Max-Age=');
      expect(remembered).toContain('Expires=');
      expect(cleared).toContain('Max-Age=0');
    }
  });
});

describe('what the policy refuses to read', () => {
  it('takes no request, so no proxy header can turn Secure off', () => {
    // Structural, and deliberately so. `X-Forwarded-Proto` is attacker-supplied
    // on any hop that does not overwrite it; the way to be sure it cannot lower
    // this cookie is for the decision to have no request in scope at all.
    expect(sessionCookieIsSecure.length).toBe(0);
    expect(sessionCookieIsSecure.toString()).not.toMatch(/forwarded|req|request|header/i);
  });
});
