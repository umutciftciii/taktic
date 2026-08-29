import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSetCookie,
  readSessionCookie,
  sessionCookieOptions,
} from '../app/session-cookie';

/**
 * The session cookie this app re-issues, and the rule that there is only one
 * place deciding what it looks like.
 *
 * Two halves, and the second is the one that keeps the first true.
 *
 * **The mirror.** Every attribute the API states is carried through unchanged,
 * `Secure` included. That attribute is why this file exists: it used to be
 * decided in five separate places from `NODE_ENV`, which Next folds to a
 * constant at build time — so a compiled server always claimed `Secure`, a
 * plain-HTTP origin handed browsers a cookie they are not allowed to keep, and
 * Safari dropped it. The HTTPS direction is asserted here rather than in the
 * browser suite because the end-to-end stack is HTTP: a header carrying
 * `Secure` is exactly what a production API sends, and this is where the app's
 * answer to it can be pinned without a certificate.
 *
 * **The scan.** The mirror is only worth anything while nothing else re-decides
 * the same thing. Five call sites used to; the scan below is what makes a sixth
 * a failing test rather than a Safari bug reported months later.
 */

const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, '../..');

/** The API's own header, for a session that was not "beni hatırla". */
const ORDINARY = 'taktic_session=abc123; Path=/; HttpOnly; SameSite=Lax';

/** The same, remembered — and over TLS, as a production API would send it. */
const REMEMBERED_SECURE =
  'taktic_session=abc123; Path=/; Max-Age=2591999; Expires=Mon, 28 Sep 2026 10:43:39 GMT; Secure; HttpOnly; SameSite=Lax';

function headersWith(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const value of setCookies) {
    headers.append('set-cookie', value);
  }
  return new Response(null, { headers });
}

describe('parsing what the API said', () => {
  it('carries Secure through when the API set it', () => {
    const parsed = parseSetCookie(REMEMBERED_SECURE);
    expect(parsed?.secure).toBe(true);
    expect(sessionCookieOptions(parsed!).secure).toBe(true);
  });

  it('carries the absence of Secure through when the API did not', () => {
    const parsed = parseSetCookie(ORDINARY);
    expect(parsed?.secure).toBe(false);
    // The whole Safari failure in one assertion: a cookie the API issued over
    // plain HTTP must not come back out of this app marked HTTPS-only.
    expect(sessionCookieOptions(parsed!).secure).toBe(false);
  });

  it('keeps a remembered session persistent, with both attributes', () => {
    const options = sessionCookieOptions(parseSetCookie(REMEMBERED_SECURE)!);
    expect(options.maxAge).toBe(2591999);
    expect(options.expires).toBeInstanceOf(Date);
  });

  it('leaves an ordinary session with no expiry at all', () => {
    const options = sessionCookieOptions(parseSetCookie(ORDINARY)!);
    // Absent, not `undefined`: passing an explicit undefined is not the same as
    // passing nothing to every cookie implementation, and the difference is
    // whether the session survives the browser closing.
    expect('maxAge' in options).toBe(false);
    expect('expires' in options).toBe(false);
  });

  it('restates HttpOnly even if the header somehow arrived without it', () => {
    const parsed = parseSetCookie('taktic_session=abc123; Path=/; SameSite=Lax');
    expect(parsed?.httpOnly).toBe(false);
    // Copied attributes may tighten this app's guarantees; they may not relax
    // them. HttpOnly is the app's own promise about its own origin.
    expect(sessionCookieOptions(parsed!).httpOnly).toBe(true);
  });

  it('takes a stricter SameSite and floors a looser one', () => {
    expect(parseSetCookie('taktic_session=a; SameSite=Strict')?.sameSite).toBe('strict');
    expect(parseSetCookie('taktic_session=a; SameSite=Lax')?.sameSite).toBe('lax');
    // `None` would be a relaxation, so mirroring refuses it.
    expect(parseSetCookie('taktic_session=a; SameSite=None')?.sameSite).toBe('lax');
    expect(parseSetCookie('taktic_session=a')?.sameSite).toBe('lax');
  });

  it('copies Path and defaults it to the origin root', () => {
    expect(parseSetCookie('taktic_session=a; Path=/')?.path).toBe('/');
    expect(parseSetCookie('taktic_session=a')?.path).toBe('/');
  });

  it('never copies a Domain onto this origin', () => {
    const options = sessionCookieOptions(
      parseSetCookie('taktic_session=a; Domain=.elsewhere.test; Path=/')!,
    );
    expect('domain' in options).toBe(false);
  });

  it('decodes the value the API encoded', () => {
    expect(parseSetCookie('taktic_session=a%2Bb%3Dc')?.value).toBe('a+b=c');
  });

  it('is null for anything it cannot make sense of', () => {
    // Every caller treats null as "no session was issued" and carries on with
    // the signed-out path it already had. Nothing here reaches a log or a URL.
    expect(parseSetCookie(null)).toBeNull();
    expect(parseSetCookie('')).toBeNull();
    expect(parseSetCookie('   ')).toBeNull();
    expect(parseSetCookie('taktic_session')).toBeNull();
    expect(parseSetCookie('; Path=/')).toBeNull();
  });
});

describe('finding the session cookie in a response', () => {
  it('picks the session out of several Set-Cookie headers', () => {
    const response = headersWith(
      'other_cookie=zzz; Path=/somewhere',
      REMEMBERED_SECURE,
      'analytics=1; Path=/',
    );
    const session = readSessionCookie(response);
    expect(session?.name).toBe('taktic_session');
    expect(session?.value).toBe('abc123');
  });

  it('ignores a response that carries no session cookie of ours', () => {
    // Repeated headers are folded into one comma-separated string by
    // `Headers.get`, and an `Expires` date contains a comma — which is why the
    // reader uses `getSetCookie` and matches the name rather than guessing.
    expect(readSessionCookie(headersWith('other_cookie=zzz; Path=/'))).toBeNull();
    expect(readSessionCookie(headersWith())).toBeNull();
  });

  it('still works on a runtime without getSetCookie', () => {
    const response = headersWith(ORDINARY);
    Object.defineProperty(response.headers, 'getSetCookie', {
      value: undefined,
      configurable: true,
    });
    expect(readSessionCookie(response)?.value).toBe('abc123');
  });
});

/**
 * Every TypeScript source of both applications, excluding build output.
 *
 * The list is asserted non-empty by the cases below: a scan that found nothing
 * because it was pointed at the wrong directory would otherwise report a clean
 * result, which is the one way this check could lie.
 */
function sourceFiles(): string[] {
  const roots = [
    'apps/web/app',
    'apps/web/lib',
    'apps/admin/app',
    'apps/admin/lib',
  ].map((path) => join(REPO_ROOT, path));

  const found: string[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === '.next') {
        continue;
      }
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
        found.push(path);
      }
    }
  };

  for (const root of roots) {
    walk(root);
  }

  return found;
}

/** The two modules allowed to decide what a cookie of this product looks like. */
const COOKIE_HELPERS = ['apps/web/app/session-cookie.ts', 'apps/admin/app/session-cookie.ts'];

function filesContaining(needle: string): string[] {
  return sourceFiles()
    .filter((path) => readFileSync(path, 'utf8').includes(needle))
    .map((path) => relative(REPO_ROOT, path).split('\\').join('/'))
    .sort();
}

describe('nothing else decides these', () => {
  it('scans a real tree', () => {
    const files = sourceFiles();
    expect(files.length, 'the source scan found nothing — it is pointed somewhere wrong').
      toBeGreaterThan(50);
    for (const helper of COOKIE_HELPERS) {
      expect(files.map((path) => relative(REPO_ROOT, path).split('\\').join('/'))).toContain(helper);
    }
  });

  it('mentions `secure:` in the cookie helpers and nowhere else', () => {
    // Five actions used to carry their own copy of this decision — sign-in,
    // both registrations, customer activation and the provider claim — plus two
    // app-owned cookies. They now pass through the helpers, which is why the
    // whole product can be fixed by changing one line in each.
    expect(filesContaining('secure:')).toEqual([...COOKIE_HELPERS].sort());
  });

  it('reads NODE_ENV nowhere in either application', () => {
    // Not a runtime read here: Next folds it to a constant when it compiles, so
    // any behaviour hung off it is frozen at build time and cannot be corrected
    // by how the server is started. That is precisely how the Safari failure
    // survived a NODE_ENV that was supposed to prevent it.
    expect(filesContaining('process.env.NODE_ENV')).toEqual([]);
  });

  it('defines the Set-Cookie parser only in the cookie helpers', () => {
    // Four private copies had drifted apart: none carried `Max-Age`, all passed
    // an explicit `expires: undefined` for an ordinary session, and none read
    // `Secure`. One parser is why there is one behaviour.
    expect(filesContaining('function parseSetCookie')).toEqual([...COOKIE_HELPERS].sort());
  });
});
