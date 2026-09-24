import { describe, expect, it } from 'vitest';
import {
  filterNavGroups,
  findActiveNavEntry,
  isNavItemActive,
  navGroups,
  type NavItem,
} from '../lib/nav';

/**
 * The sidebar's structure and its "you are here" rule (ADMIN-DESIGN-001).
 *
 * `/requests` lights up on every request screen, including a request's
 * detail. `/requests/reports` sits under the same prefix, and before the
 * more-specific-wins rule the queue lit two rows at once. These cases pin
 * the rule through the real nav list, so a row added under another row's
 * prefix is covered without a test naming it.
 */

const rows = navGroups.flatMap((group) => group.items);

function item(href: string): NavItem {
  const found = rows.find((entry) => entry.href === href);
  if (!found) throw new Error(`No nav item at ${href}`);
  return found;
}

function activeHrefs(pathname: string): string[] {
  return rows.filter((entry) => isNavItemActive(entry, pathname)).map((entry) => entry.href);
}

function groupOf(href: string): string | undefined {
  return navGroups.find((group) => group.items.some((entry) => entry.href === href))?.title;
}

describe('the groups', () => {
  it('are the design’s eight, in its order, under the bare "Genel görünüm" row', () => {
    expect(navGroups.map((group) => group.title)).toEqual([
      'Panel',
      'Talepler',
      'Teklifler',
      'Kişiler',
      'Finans',
      'Vitrin',
      'Katalog',
      'Operasyon',
      'Yönetim',
    ]);
    expect(navGroups.filter((group) => group.bare).map((group) => group.key)).toEqual(['panel']);
  });

  it('have unique keys and unique row paths', () => {
    const keys = navGroups.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
    const hrefs = rows.map((entry) => entry.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('carry no SEO group and no "Eşleşmeler" row (SEO-004, K8)', () => {
    expect(navGroups.some((group) => /seo/i.test(group.title) || group.key === 'seo')).toBe(false);
    expect(rows.some((entry) => entry.label === 'Eşleşmeler')).toBe(false);
  });

  it('give every row exactly one gate: a permission or superAdminOnly', () => {
    for (const entry of rows) {
      expect(Boolean(entry.permission) !== Boolean(entry.superAdminOnly), entry.href).toBe(true);
    }
  });
});

describe('the five rows the design had no place for (K1)', () => {
  it.each([
    ['/package-refunds', 'Finans', 'Paket iadeleri', 'PACKAGE_REFUND_READ'],
    ['/showcase/cards', 'Vitrin', 'Vitrin kartları', 'SHOWCASE_CARDS_READ'],
    ['/showcase/price-terms', 'Vitrin', 'Vitrin metin onayları', 'SHOWCASE_TERMS_ACCEPTANCES_READ'],
    ['/promotion-eligibility', 'Operasyon', 'Kampanya uygunluk incelemesi', 'PROMOTION_ELIGIBILITY_REVIEW'],
  ])('%s sits under %s as "%s" on %s', (href, group, label, permission) => {
    expect(groupOf(href)).toBe(group);
    expect(item(href).label).toBe(label);
    expect(item(href).permission).toBe(permission);
    expect(item(href).superAdminOnly).toBeUndefined();
  });

  it('/roles sits under Yönetim and stays root-only, with no permission that could reveal it', () => {
    expect(groupOf('/roles')).toBe('Yönetim');
    expect(item('/roles').label).toBe('Roller ve izinler');
    expect(item('/roles').superAdminOnly).toBe(true);
    expect(item('/roles').permission).toBeUndefined();
  });
});

describe('the report queue rows', () => {
  it('the request queue sits in Talepler right after the list, and is the only row lit on it', () => {
    const hrefs = navGroups.find((group) => group.key === 'talepler')?.items.map((entry) => entry.href);
    expect(hrefs).toEqual(['/requests', '/requests/reports']);
    expect(activeHrefs('/requests/reports')).toEqual(['/requests/reports']);
  });

  it('the review queue lights on itself; a review detail is claimed by no row', () => {
    expect(groupOf('/provider-reviews/reports')).toBe('Vitrin');
    expect(activeHrefs('/provider-reviews/reports')).toEqual(['/provider-reviews/reports']);
    expect(activeHrefs('/provider-reviews/abc123')).toEqual([]);
  });
});

describe('the most specific row wins', () => {
  it('keeps "Tüm talepler" lit on the list and on a request detail', () => {
    expect(activeHrefs('/requests')).toEqual(['/requests']);
    expect(activeHrefs('/requests/abc123')).toEqual(['/requests']);
    expect(activeHrefs('/requests/reportsXYZ')).toEqual(['/requests']);
  });

  it.each([
    ['/showcase/cards', ['/showcase/cards']],
    ['/showcase/reviews', ['/showcase/reviews']],
    ['/showcase/reviews/v1', ['/showcase/reviews']],
    ['/showcase/placements/p1', ['/showcase/placements']],
    ['/showcase/price-terms', ['/showcase/price-terms']],
    ['/showcase/packages', ['/showcase/packages']],
    ['/package-refunds', ['/package-refunds']],
    ['/package-refunds/r1', ['/package-refunds']],
    ['/package-purchases', ['/package-purchases']],
    ['/package-purchases/p1', ['/package-purchases']],
    ['/promotion-eligibility/e1', ['/promotion-eligibility']],
    ['/providers/x/credits', ['/providers']],
    ['/roles/r1', ['/roles']],
  ])('%s lights %j and nothing else', (pathname, expected) => {
    expect(activeHrefs(pathname)).toEqual(expected);
  });

  it('does not let one prefix borrow another: /package-refunds is not /package-purchases', () => {
    expect(isNavItemActive(item('/package-purchases'), '/package-refunds')).toBe(false);
    expect(isNavItemActive(item('/package-refunds'), '/package-purchases')).toBe(false);
  });

  it('keeps exact rows to their own path', () => {
    expect(activeHrefs('/')).toEqual(['/']);
    expect(activeHrefs('/finance')).toEqual(['/finance']);
    expect(activeHrefs('/finance/credit-ledger')).toEqual(['/finance/credit-ledger']);
    expect(activeHrefs('/finance/unknown')).toEqual([]);
  });
});

describe('filterNavGroups', () => {
  const only = (...held: string[]) => (permission: string) => held.includes(permission);

  it('keeps the rows a session holds and drops a group once it is empty', () => {
    const groups = filterNavGroups(navGroups, only('DASHBOARD_READ', 'CUSTOMERS_READ'));
    expect(groups.map((group) => group.key)).toEqual(['panel', 'kisiler']);
    expect(groups[1]?.items.map((entry) => entry.href)).toEqual(['/customers']);
  });

  it('never shows /roles to a staff account, whatever it holds', () => {
    const everything = filterNavGroups(navGroups, () => true, false);
    expect(everything.flatMap((group) => group.items).some((entry) => entry.href === '/roles')).toBe(false);
    const root = filterNavGroups(navGroups, () => true, true);
    expect(root.flatMap((group) => group.items).some((entry) => entry.href === '/roles')).toBe(true);
  });

  it('drops Yönetim entirely for a super-admin-less session that holds none of its reads', () => {
    const groups = filterNavGroups(navGroups, only('FINANCE_READ'));
    expect(groups.map((group) => group.key)).toEqual(['finans']);
    expect(groups[0]?.items.map((entry) => entry.href)).toEqual(['/finance', '/finance/providers']);
  });
});

describe('findActiveNavEntry — the top bar reads the filtered groups (F18)', () => {
  it('names the group and the row the session was given', () => {
    const groups = filterNavGroups(navGroups, () => true, true);
    const entry = findActiveNavEntry(groups, '/showcase/cards');
    expect(entry?.group.title).toBe('Vitrin');
    expect(entry?.item.label).toBe('Vitrin kartları');
  });

  it('names nothing for a row the session does not hold, even when the path matches it', () => {
    const groups = filterNavGroups(navGroups, (permission) => permission === 'REQUESTS_READ');
    expect(findActiveNavEntry(groups, '/requests/abc')?.item.href).toBe('/requests');
    // The queue belongs to REQUEST_REPORTS_READ. The list row is not lit on it
    // either: specificity is judged against the whole menu.
    expect(findActiveNavEntry(groups, '/requests/reports')).toBeNull();
  });
});
