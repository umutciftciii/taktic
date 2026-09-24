import { describe, expect, it } from 'vitest';
import {
  allNavItems,
  filterNavGroups,
  filterNavMenu,
  findActiveNavEntry,
  isNavItemActive,
  navGroups,
  navHome,
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

const rows = allNavItems();

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
  it('are exactly eight, in the design’s order', () => {
    expect(navGroups.map((group) => group.title)).toEqual([
      'Talepler',
      'Teklifler',
      'Kişiler',
      'Finans',
      'Vitrin',
      'Katalog',
      'Operasyon',
      'Yönetim',
    ]);
    expect(navGroups).toHaveLength(8);
  });

  it('keep "Genel görünüm" out of them: it is one top-level dashboard row, not a group', () => {
    expect(navHome).toEqual({ href: '/', label: 'Genel görünüm', exact: true, permission: 'DASHBOARD_READ' });
    expect(navGroups.some((group) => group.items.some((entry) => entry.href === '/'))).toBe(false);
    expect(navGroups.some((group) => /genel|panel/i.test(group.title) || group.items.length === 0)).toBe(false);
    expect(allNavItems()[0]).toBe(navHome);
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
    expect(groups.map((group) => group.key)).toEqual(['kisiler']);
    expect(groups[0]?.items.map((entry) => entry.href)).toEqual(['/customers']);
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

describe('filterNavMenu — the dashboard row and the groups, by one rule', () => {
  const only = (...held: string[]) => (permission: string) => held.includes(permission);

  it('gives the dashboard row only to a session holding DASHBOARD_READ, never as a group', () => {
    const withHome = filterNavMenu(only('DASHBOARD_READ'));
    expect(withHome.home).toBe(navHome);
    expect(withHome.groups).toEqual([]);

    const without = filterNavMenu(only('CUSTOMERS_READ'));
    expect(without.home).toBeNull();
    expect(without.groups.map((group) => group.key)).toEqual(['kisiler']);
  });

  it('gives a super admin the row and all eight groups', () => {
    const menu = filterNavMenu(() => true, true);
    expect(menu.home).toBe(navHome);
    expect(menu.groups).toHaveLength(8);
  });
});

describe('findActiveNavEntry — the top bar reads the filtered menu (F18)', () => {
  it('names the group and the row the session was given', () => {
    const entry = findActiveNavEntry(filterNavMenu(() => true, true), '/showcase/cards');
    expect(entry?.group?.title).toBe('Vitrin');
    expect(entry?.item.label).toBe('Vitrin kartları');
  });

  it('names the dashboard row with no group', () => {
    const entry = findActiveNavEntry(filterNavMenu(() => true, true), '/');
    expect(entry?.group).toBeNull();
    expect(entry?.item).toBe(navHome);
    expect(findActiveNavEntry(filterNavMenu(() => false), '/')).toBeNull();
  });

  it('names nothing for a row the session does not hold, even when the path matches it', () => {
    const menu = filterNavMenu((permission) => permission === 'REQUESTS_READ');
    expect(findActiveNavEntry(menu, '/requests/abc')?.item.href).toBe('/requests');
    // The queue belongs to REQUEST_REPORTS_READ. The list row is not lit on it
    // either: specificity is judged against the whole menu.
    expect(findActiveNavEntry(menu, '/requests/reports')).toBeNull();
  });
});
