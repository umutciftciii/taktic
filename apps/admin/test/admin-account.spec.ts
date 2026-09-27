import { describe, expect, it } from 'vitest';
import { adminInitials, describeAdminRole, summarizeAdminAccount } from '../lib/admin-account';

/**
 * The sidebar's account block (K13): what it calls the session, counted from
 * the same `/admin/me/permissions` answer the menu and the page guards read.
 */
describe('describeAdminRole', () => {
  it('calls a super admin "Süper yönetici"', () => {
    expect(describeAdminRole({ isSuperAdmin: true, permissions: ['A', 'B'] })).toBe('Süper yönetici');
  });

  it('counts a staff account’s permissions', () => {
    expect(describeAdminRole({ isSuperAdmin: false, permissions: ['DASHBOARD_READ', 'CUSTOMERS_READ'] })).toBe(
      'Yetkili personel · 2 yetki',
    );
    expect(describeAdminRole({ isSuperAdmin: false, permissions: [] })).toBe('Yetkili personel · 0 yetki');
  });

  it('counts a repeated value once', () => {
    expect(describeAdminRole({ isSuperAdmin: false, permissions: ['A', 'A', 'B'] })).toBe(
      'Yetkili personel · 2 yetki',
    );
  });

  it('never says "Tam yetkili yönetici"', () => {
    for (const access of [
      { isSuperAdmin: true, permissions: [] },
      { isSuperAdmin: false, permissions: ['A'] },
    ]) {
      expect(describeAdminRole(access)).not.toMatch(/tam yetkili/i);
    }
  });
});

describe('the name beside it', () => {
  it('takes two initials from a name, in Turkish upper case', () => {
    expect(adminInitials('umut çiftçi')).toBe('UÇ');
    expect(adminInitials('ilke')).toBe('İ');
  });

  it('takes one from an address, and a dot when there is nothing', () => {
    expect(adminInitials('admin@taktic.local')).toBe('A');
    expect(adminInitials(null)).toBe('·');
    expect(adminInitials('   ')).toBe('·');
  });

  it('falls back from the name to the address, and to the role line alone', () => {
    const access = { isSuperAdmin: false, permissions: ['A'] };
    expect(summarizeAdminAccount(access, { name: 'Ayşe Demir', email: 'a@x.test' }).displayName).toBe('Ayşe Demir');
    expect(summarizeAdminAccount(access, { name: null, email: 'a@x.test' }).displayName).toBe('a@x.test');
    const bare = summarizeAdminAccount(access, null);
    expect(bare.displayName).toBeNull();
    expect(bare.roleLabel).toBe('Yetkili personel · 1 yetki');
  });
});
