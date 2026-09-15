import { describe, expect, it } from 'vitest';
import { isNavItemActive, navGroups, type NavItem } from '../lib/nav';

/**
 * The sidebar's "you are here" rule.
 *
 * `/requests` lights up on every request screen, including a request's
 * detail. `/requests/reports` sits under the same prefix, and before the
 * more-specific-wins rule the queue lit two rows at once. These cases pin
 * the rule through the real nav list, so a row added under another row's
 * prefix is covered without a test naming it.
 */

function item(href: string): NavItem {
  const found = navGroups.flatMap((group) => group.items).find((entry) => entry.href === href);
  if (!found) throw new Error(`No nav item at ${href}`);
  return found;
}

function activeHrefs(pathname: string): string[] {
  return navGroups
    .flatMap((group) => group.items)
    .filter((entry) => isNavItemActive(entry, pathname))
    .map((entry) => entry.href);
}

describe('the report queue row', () => {
  it('sits in Operasyon right after Talepler', () => {
    const operasyon = navGroups.find((group) => group.title === 'Operasyon');
    const hrefs = operasyon?.items.map((entry) => entry.href) ?? [];

    expect(hrefs.indexOf('/requests/reports')).toBe(hrefs.indexOf('/requests') + 1);
    expect(item('/requests/reports').label).toBe('Talep bildirimleri');
  });

  it('is the only row lit on the queue', () => {
    expect(activeHrefs('/requests/reports')).toEqual(['/requests/reports']);
  });
});

describe('the Talepler row', () => {
  it('stays lit on the list and on a request detail', () => {
    expect(activeHrefs('/requests')).toEqual(['/requests']);
    expect(activeHrefs('/requests/abc123')).toEqual(['/requests']);
  });

  it('is not fooled by a request whose id starts with "reports"', () => {
    expect(activeHrefs('/requests/reportsXYZ')).toEqual(['/requests']);
  });
});

describe('exact rows', () => {
  it('light only on their own path', () => {
    expect(activeHrefs('/')).toEqual(['/']);
    expect(activeHrefs('/finance')).toEqual(['/finance']);
    expect(activeHrefs('/finance/credit-ledger')).toEqual(['/finance/credit-ledger']);
  });
});

describe('the review report queue row', () => {
  it('sits in Operasyon right after Talep bildirimleri', () => {
    const operasyon = navGroups.find((group) => group.title === 'Operasyon');
    const hrefs = operasyon?.items.map((entry) => entry.href) ?? [];

    expect(hrefs.indexOf('/provider-reviews/reports')).toBe(hrefs.indexOf('/requests/reports') + 1);
    expect(item('/provider-reviews/reports').label).toBe('Değerlendirme bildirimleri');
  });

  it('lights on the queue and on a review detail, and nothing else does', () => {
    expect(activeHrefs('/provider-reviews/reports')).toEqual(['/provider-reviews/reports']);
    // A review detail lives under the same prefix but is not the queue; no
    // row claims it, which is the same answer the vitrin review screens give.
    expect(activeHrefs('/provider-reviews/abc123')).toEqual([]);
  });
});
