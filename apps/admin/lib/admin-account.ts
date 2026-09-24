/**
 * What the sidebar's account block says about the signed-in session (K13).
 *
 * Derived from `GET /admin/me/permissions` alone — the same answer the menu
 * and every page guard read — so it cannot disagree with what the session may
 * open. The design's "Tam yetkili yönetici" is deliberately not a value this
 * returns: a staff account is not fully authorised, and a super admin is
 * called what the product calls it.
 */
export type AdminAccountSummary = {
  /** The person's name, or their address when the account has no name. */
  displayName: string | null;
  /** Up to two letters for the dark tile beside the name. */
  initials: string;
  /** "Süper yönetici", or "Yetkili personel · N yetki". */
  roleLabel: string;
};

export function describeAdminRole(access: { isSuperAdmin: boolean; permissions: readonly string[] }): string {
  if (access.isSuperAdmin) {
    return 'Süper yönetici';
  }
  // Counted as distinct values: the API sorts and de-duplicates, but a count
  // that could say "3 yetki" for two is not worth trusting to that.
  return `Yetkili personel · ${new Set(access.permissions).size} yetki`;
}

export function adminInitials(displayName: string | null): string {
  const source = (displayName ?? '').trim();
  if (!source) return '·';
  // An address has no second word worth taking a letter from.
  const words = source.includes('@') ? [source] : source.split(/\s+/);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('');
  return letters.toLocaleUpperCase('tr-TR') || '·';
}

export function summarizeAdminAccount(
  access: { isSuperAdmin: boolean; permissions: readonly string[] },
  identity: { name: string | null; email: string | null } | null,
): AdminAccountSummary {
  const displayName = identity?.name?.trim() || identity?.email?.trim() || null;
  return {
    displayName,
    initials: adminInitials(displayName),
    roleLabel: describeAdminRole(access),
  };
}
