import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFE_REDIRECT,
  safeRedirectPath,
  safeRedirectPathOrNull,
} from './safe-redirect';

/**
 * The open-redirect guard, from both sides.
 *
 * The "accepts" block is the product requirement — somebody sent to sign in
 * from three pages deep has to land back on that page, query string and all —
 * and the "refuses" block is the security one. They belong in the same file
 * because the failure mode of tightening this helper is silently breaking the
 * first, and the failure mode of relaxing it is silently breaking the second.
 *
 * Every hostile destination below points at `evil.example`, which is reserved
 * by RFC 2606 and resolves nowhere.
 */
describe('safeRedirectPath', () => {
  describe('accepts a path inside the application', () => {
    const accepted = [
      '/',
      '/requests/my',
      '/providers/prov-1/requests',
      '/destek/ticket-1',
      '/mesajlar/talep/req-1',
    ];

    for (const path of accepted) {
      it(`keeps ${path}`, () => {
        expect(safeRedirectPath(path)).toBe(path);
      });
    }

    it('keeps the query string', () => {
      expect(safeRedirectPath('/requests/offers?status=NEW&page=2')).toBe(
        '/requests/offers?status=NEW&page=2',
      );
    });

    it('keeps the fragment', () => {
      expect(safeRedirectPath('/destek/ticket-1#mesajlar')).toBe('/destek/ticket-1#mesajlar');
    });

    it('keeps a query string and a fragment together', () => {
      expect(safeRedirectPath('/providers/p1/offers?tab=sent#top')).toBe(
        '/providers/p1/offers?tab=sent#top',
      );
    });

    it('keeps percent-encoded characters that decode to an ordinary path segment', () => {
      expect(safeRedirectPath('/destek/bir%20kayit')).toBe('/destek/bir%20kayit');
    });

    it('ignores whitespace a browser would strip anyway', () => {
      expect(safeRedirectPath('  /requests/my  ')).toBe('/requests/my');
    });
  });

  describe('refuses anything that could leave this origin', () => {
    const refused: Array<[string, string]> = [
      ['an https URL', 'https://evil.example/login'],
      ['an http URL', 'http://evil.example/login'],
      ['an uppercase scheme', 'HTTPS://evil.example'],
      ['a protocol-relative URL', '//evil.example'],
      ['a protocol-relative URL with a path', '//evil.example/takeover'],
      ['three slashes', '///evil.example'],
      ['four slashes', '////evil.example'],
      ['a backslash pair', '\\\\evil.example'],
      ['a slash-backslash pair', '/\\evil.example'],
      ['a backslash-slash pair', '\\/evil.example'],
      ['a backslash further along the path', '/requests\\@evil.example'],
      ['a javascript: URL', 'javascript:alert(document.cookie)'],
      ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
      ['a bare hostname', 'evil.example'],
      ['a relative path with no leading slash', 'requests/my'],
      ['an encoded protocol-relative URL', '/%2f%2fevil.example'],
      ['an encoded protocol-relative URL, upper case', '/%2F%2Fevil.example'],
      ['a double-encoded protocol-relative URL', '/%252f%252fevil.example'],
      ['an encoded backslash pair', '/%5c%5cevil.example'],
      ['an encoded newline before a scheme', '/%0a%0dhttps://evil.example'],
      ['malformed percent-encoding', '/%zz'],
      ['a lone percent sign', '/%'],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ];

    for (const [name, value] of refused) {
      it(`refuses ${name}`, () => {
        expect(safeRedirectPathOrNull(value)).toBeNull();
        expect(safeRedirectPath(value)).toBe(DEFAULT_SAFE_REDIRECT);
      });
    }

    it('refuses a newline that would smuggle a second header', () => {
      expect(safeRedirectPathOrNull('/requests/my\r\nLocation: https://evil.example')).toBeNull();
    });

    it('refuses a tab before a protocol-relative URL', () => {
      expect(safeRedirectPathOrNull('/\t/evil.example')).toBeNull();
    });

    it('refuses a NUL byte', () => {
      expect(safeRedirectPathOrNull('/requests\u0000/my')).toBeNull();
    });

    it('refuses values that are not strings', () => {
      expect(safeRedirectPathOrNull(undefined)).toBeNull();
      expect(safeRedirectPathOrNull(null)).toBeNull();
      expect(safeRedirectPathOrNull(42)).toBeNull();
      expect(safeRedirectPathOrNull(['/requests/my'])).toBeNull();
    });
  });

  describe('the fallback', () => {
    it('is the site root unless the caller names another', () => {
      expect(safeRedirectPath('https://evil.example')).toBe('/');
    });

    it('is the route the caller names, when it names one', () => {
      expect(safeRedirectPath('https://evil.example', '/credit-packages')).toBe('/credit-packages');
    });

    it('is not consulted when the destination is safe', () => {
      expect(safeRedirectPath('/requests/my', '/credit-packages')).toBe('/requests/my');
    });
  });
});
