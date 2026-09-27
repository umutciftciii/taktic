import { describe, expect, it } from 'vitest';
import { buildHref, buildQueryString, pageHref, parsePage, resolveTab, tabHref } from '../lib/list-query';

/**
 * ADMIN-DESIGN-001 Faz 2 — the URLs the shared list components write.
 *
 * Filters, saved views, tabs and pages are all query parameters, so these
 * rules are what make a copied address reopen the same view.
 */
describe('list query helpers', () => {
  it('drops empty values instead of writing `?key=`', () => {
    expect(buildQueryString({ status: '', channel: 'EMAIL', page: undefined, userId: null })).toBe('?channel=EMAIL');
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString({ a: '' })).toBe('');
  });

  it('applies overrides on top of the current query, and an empty override removes a key', () => {
    expect(buildHref('/x', { status: 'FAILED', channel: 'SMS' }, { channel: undefined, page: 3 })).toBe(
      '/x?status=FAILED&page=3',
    );
  });

  it('encodes values', () => {
    expect(buildHref('/x', { q: 'a&b c' })).toBe('/x?q=a%26b+c');
  });

  it('writes the default tab as the plain URL and always drops the page', () => {
    const params = { channel: 'EMAIL', page: 4 };
    expect(tabHref({ path: '/n', params, param: 'status', key: '' })).toBe('/n?channel=EMAIL');
    expect(tabHref({ path: '/n', params, param: 'status', key: 'FAILED' })).toBe('/n?channel=EMAIL&status=FAILED');
    expect(tabHref({ path: '/r/1', params: {}, param: 'tab', key: 'bilgi', defaultKey: 'bilgi' })).toBe('/r/1');
    expect(tabHref({ path: '/r/1', params: {}, param: 'tab', key: 'teklifler', defaultKey: 'bilgi' })).toBe(
      '/r/1?tab=teklifler',
    );
  });

  it('keeps a tab parameter already in the query in its place when switching', () => {
    expect(tabHref({ path: '/n', params: { status: 'SENT', userId: 'u1' }, param: 'status', key: 'FAILED' })).toBe(
      '/n?status=FAILED&userId=u1',
    );
  });

  it('writes page 1 without a parameter', () => {
    expect(pageHref('/n', { userId: 'u1' }, 1)).toBe('/n?userId=u1');
    expect(pageHref('/n', { userId: 'u1' }, 2)).toBe('/n?userId=u1&page=2');
    expect(pageHref('/n', {}, 0)).toBe('/n');
  });

  it('trusts a ?tab= value only if it names a real tab', () => {
    const keys = ['bilgi', 'teklifler'] as const;
    expect(resolveTab('teklifler', keys, 'bilgi')).toBe('teklifler');
    expect(resolveTab('yok', keys, 'bilgi')).toBe('bilgi');
    expect(resolveTab(undefined, keys, 'bilgi')).toBe('bilgi');
  });

  it('parses a page number, falling back to 1', () => {
    expect(parsePage('3')).toBe(3);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('abc')).toBe(1);
    expect(parsePage(undefined)).toBe(1);
  });
});
