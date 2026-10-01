import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionMatrix } from '../app/roles/permission-matrix';
import { PermissionSaveConsequence, RolePermissionsForm, RoleStatusForm, describeReach } from '../app/roles/role-forms';
import { RevokeConsequence } from '../app/users/[id]/role-assignment-card';
import { adminPermissionLabel } from '../lib/api';
import { groupPermissions } from '../lib/permission-groups';
import {
  diffPermissions,
  effectivePermissions,
  permissionLines,
  permissionsLostOnRevoke,
  roleReach,
} from '../lib/permission-model';

/**
 * ADMIN-DESIGN-001 Faz 3G — sistem ve yönetim: /company-settings,
 * /notifications/[id], /users/new, /users/[id], /roles, /roles/[id].
 *
 * Pinned here: the role matrix draws the whole closed catalogue grouped by
 * area with each permission's label and raw value; the confirmation figures
 * come from the data the page read and nothing else; the deactivation still
 * needs `confirm=on`, sent only by a hydrated dialog; and every route,
 * section and action gate is where it was.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

/** The catalogue as the schema defines it — the API returns exactly this set. */
function schemaCatalogue(): string[] {
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const body = schema.split('enum AdminPermission {')[1]!.split('}')[0]!;
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z_]+$/.test(line))
    .sort();
}

describe('permission matrix: the whole catalogue, grouped by area', () => {
  const catalogue = schemaCatalogue();
  const groups = groupPermissions(catalogue);

  it('keeps every permission exactly once, in its adminPermissionLabel area', () => {
    expect(catalogue.length).toBeGreaterThanOrEqual(80);
    const drawn = groups.flatMap((group) => group.items.map((item) => item.permission));
    expect(drawn.sort()).toEqual(catalogue);
    for (const group of groups) {
      for (const item of group.items) {
        expect(adminPermissionLabel(item.permission)).toEqual({ area: group.area, action: item.action });
      }
    }
    // Areas in Turkish order, and no area named by a raw enum prefix.
    expect(groups.map((group) => group.area)).toEqual(
      [...groups.map((group) => group.area)].sort((a, b) => a.localeCompare(b, 'tr')),
    );
    expect(groups.map((group) => group.area).filter((area) => /^[A-Z_]+$/.test(area))).toEqual([]);
    expect(adminPermissionLabel('CATALOG_READ')).toEqual({ area: 'Katalog', action: 'okuma' });
  });

  it('draws one named checkbox per permission, with its label and its raw value, ticked from the role', () => {
    const selected = ['REQUESTS_READ', 'SUPPORT_READ', 'SUPPORT_WRITE'];
    const markup = html(<PermissionMatrix groups={groups} selected={selected} />);
    expect(markup.match(/<input type="checkbox" name="permissions"/g)).toHaveLength(catalogue.length);
    for (const permission of catalogue) {
      expect(markup).toContain(`value="${permission}"`);
      expect(markup).toContain(`<code class="admin-permission-code">${permission}</code>`);
    }
    expect(markup.match(/checked=""/g)).toHaveLength(3);
    expect(markup).toContain(`${catalogue.length} izinden <strong>3</strong> tanesi seçili · ${groups.length} alan`);
    // The per-area count is of that area only.
    const support = groups.find((group) => group.area === 'Destek')!;
    expect(markup).toContain(`data-area="Destek"><legend><span>Destek</span><span class="admin-permission-count" data-testid="permission-group-count">2/${support.items.length}</span>`);
    // Nothing but the catalogue: no free-text permission field, no "add" control.
    expect(markup).not.toMatch(/type="text"/);
    expect(markup).not.toMatch(/İzin ekle/);
  });
});

describe('role arithmetic', () => {
  it('diffs a permission set both ways', () => {
    expect(diffPermissions(['A', 'B', 'C'], ['B', 'D'])).toEqual({ added: ['D'], removed: ['A', 'C'] });
    expect(diffPermissions(['A'], ['A'])).toEqual({ added: [], removed: [] });
  });

  it('counts the live holders the role detail returned, and the active ones among them', () => {
    expect(roleReach([{ user: { isActive: true } }, { user: { isActive: false } }, { user: { isActive: true } }])).toEqual({
      holders: 3,
      activeHolders: 2,
    });
    expect(roleReach([])).toEqual({ holders: 0, activeHolders: 0 });
  });

  const assignments = [
    { revokedAt: null, role: { id: 'r1', isActive: true, permissions: ['A', 'B', 'C'] } },
    { revokedAt: null, role: { id: 'r2', isActive: true, permissions: ['B'] } },
    { revokedAt: null, role: { id: 'r3', isActive: false, permissions: ['C', 'D'] } },
    { revokedAt: '2026-09-01T00:00:00.000Z', role: { id: 'r4', isActive: true, permissions: ['E'] } },
  ];

  it('reads an account’s effective set as its live, active roles only', () => {
    expect(effectivePermissions(assignments)).toEqual(['A', 'B', 'C']);
  });

  it('names what a revoke really takes away: nothing another live, active role still grants', () => {
    // B stays through r2; C is also in r3, but r3 is inactive and grants nothing.
    expect(permissionsLostOnRevoke(assignments, 'r1')).toEqual(['A', 'C']);
    expect(permissionsLostOnRevoke(assignments, 'r2')).toEqual([]);
    // An inactive role grants nothing today, so taking it back takes nothing.
    expect(permissionsLostOnRevoke(assignments, 'r3')).toEqual([]);
    // A revoked assignment is not held.
    expect(permissionsLostOnRevoke(assignments, 'r4')).toEqual([]);
  });
});

describe('confirmations say what the data says', () => {
  const lines = permissionLines([
    { area: 'Destek', items: [{ permission: 'SUPPORT_READ', action: 'okuma' }, { permission: 'SUPPORT_WRITE', action: 'yazma' }] },
  ]);

  it('the matrix save lists the change and the role’s real reach', () => {
    const markup = html(
      <PermissionSaveConsequence
        added={['SUPPORT_WRITE']}
        removed={['SUPPORT_READ']}
        nextCount={4}
        lines={lines}
        reach={{ holders: 3, activeHolders: 2 }}
        roleActive
      />,
    );
    expect(markup).toContain('1 izin eklenecek, 1 izin kaldırılacak. Kayıttan sonra rol 4 izin taşır');
    expect(markup).toContain('Destek · yazma <code>SUPPORT_WRITE</code>');
    expect(markup).toContain('Destek · okuma <code>SUPPORT_READ</code>');
    expect(markup).toContain('Bu rolü taşıyan 3 hesap (2 tanesi aktif) kayıt anında bu izinlerle çalışmaya başlar');
  });

  it('an inactive or unassigned role reaches nobody today, and says so', () => {
    const inactive = html(
      <PermissionSaveConsequence added={['SUPPORT_READ']} removed={[]} nextCount={1} lines={lines} reach={{ holders: 2, activeHolders: 1 }} roleActive={false} />,
    );
    expect(inactive).toContain('Rol pasif; kayıt şu an kimsenin yetkisini değiştirmez. Bu rolü taşıyan 2 hesap (1 tanesi aktif)');
    const nobody = html(
      <PermissionSaveConsequence added={['SUPPORT_READ']} removed={[]} nextCount={1} lines={lines} reach={{ holders: 0, activeHolders: 0 }} roleActive />,
    );
    expect(nobody).toContain('Bu rol şu an hiçbir hesaba atanmış değil; kayıt kimsenin yetkisini değiştirmez.');
    expect(describeReach({ holders: 0, activeHolders: 0 })).not.toMatch(/\d/);
  });

  it('the revoke names the permissions the account loses, or that it loses none', () => {
    expect(html(<RevokeConsequence lost={['SUPPORT_READ']} roleActive roleSize={3} />)).toContain(
      'Bu hesap 1 izni hemen kaybeder',
    );
    expect(html(<RevokeConsequence lost={[]} roleActive roleSize={3} />)).toContain(
      'Rolün 3 izninin tamamı bu hesabın başka aktif bir rolünde de var',
    );
    expect(html(<RevokeConsequence lost={[]} roleActive={false} roleSize={3} />)).toContain('Rol pasif olduğu için');
  });
});

describe('role forms keep their actions’ contracts', () => {
  const groups = [{ area: 'Destek', items: [{ permission: 'SUPPORT_READ', action: 'okuma' }] }];

  it('the matrix save posts roleId and permissions[], and its trigger stays closed until something changed', () => {
    const markup = html(
      <RolePermissionsForm
        roleId="role-1"
        groups={groups}
        selected={['SUPPORT_READ']}
        reach={{ holders: 1, activeHolders: 1 }}
        roleActive
        action={noop}
      />,
    );
    expect(markup).toContain('<input type="hidden" name="roleId" value="role-1"/>');
    expect(markup).toContain('name="permissions" checked="" value="SUPPORT_READ"');
    const trigger = markup.match(/<button type="submit"[^>]*>İzinleri kaydet<\/button>/)?.[0] ?? '';
    expect(trigger).toContain('disabled=""');
    expect(markup).toContain('type="reset"');
  });

  it('both directions ask first; neither form carries a confirmation value of its own', () => {
    const active = html(
      <RoleStatusForm roleId="role-1" roleName="Destek" isActive permissionCount={2} reach={{ holders: 3, activeHolders: 2 }} action={noop} />,
    );
    expect(active).toContain('<input type="hidden" name="isActive" value="false"/>');
    expect(active).not.toContain('name="confirm"');
    expect(active).toMatch(/<button type="submit"[^>]*aria-haspopup="dialog"[^>]*>Rolü pasifleştir<\/button>/);
    expect(active).toContain('Bu rolü taşıyan 3 hesap (2 tanesi aktif) bu rolün 2 iznini hemen kaybeder');

    const inactive = html(
      <RoleStatusForm roleId="role-1" roleName="Destek" isActive={false} permissionCount={2} reach={{ holders: 3, activeHolders: 2 }} action={noop} />,
    );
    // ADMIN-DESTRUCTIVE-CONFIRMATION-001: reactivating asks too.
    expect(inactive).toContain('<input type="hidden" name="isActive" value="true"/>');
    expect(inactive).not.toContain('name="confirm"');
    expect(inactive).toMatch(/<button type="submit"[^>]*aria-haspopup="dialog"[^>]*>Rolü aktifleştir<\/button>/);
    expect(inactive).toContain('data-testid="role-activate-dialog"');
    expect(inactive).toContain('Bu rolü taşıyan 3 hesap (2 tanesi aktif) bu rolün 2 iznini hemen geri kazanır');
  });

  it('every role write refuses a submission without the dialog proof', () => {
    const actions = read('app/roles/actions.ts');
    // ADMIN-DESTRUCTIVE-CONFIRMATION-001: the dialog's single-use proof, not a
    // fixed `confirm=on`, is what the action checks — for every role write.
    expect(actions).not.toContain("'confirm'");
    for (const key of ["'role.status'", "'role.permissions'", "'role.assign'", "'role.revoke'"]) {
      expect(actions).toContain(`await refuseWithoutProof(formData, ${key},`);
    }
    // The four role writes and two assignment writes are the same calls.
    for (const call of [
      "'/admin/roles'",
      '`/admin/roles/${id}`',
      '`/admin/roles/${id}/permissions`',
      '`/admin/users/${userId}/roles`',
      '`/admin/users/${userId}/roles/${roleId}`',
    ]) {
      expect(actions).toContain(call);
    }
  });
});

describe('route, section and action gates (source)', () => {
  it('/company-settings: COMPANY_SETTINGS_READ, the form behind COMPANY_SETTINGS_WRITE', () => {
    const source = read('app/company-settings/page.tsx');
    expect(source).toContain("requireAdmin('COMPANY_SETTINGS_READ')");
    expect(source).toContain("const canWrite = can('COMPANY_SETTINGS_WRITE')");
    expect(source).toMatch(/\{canWrite \? \(\s*<form action=\{saveCompanySettingsAction\}/);
    expect(source).toContain('data-testid="company-settings-readonly"');
    // Nothing technical is read or rendered.
    expect(source).not.toMatch(/RESEND|EMAIL_FROM|process\.env/);
  });

  it('/notifications/[id]: NOTIFICATION_LOGS_READ; retry only when retryable and NOTIFICATION_RETRY', () => {
    const source = read('app/notifications/[id]/page.tsx');
    expect(source).toContain("requireAdmin('NOTIFICATION_LOGS_READ')");
    expect(source).toContain("const canRetry = can('NOTIFICATION_RETRY')");
    expect(source).toContain('{entry.retryable && canRetry ? (');
    expect(source).toContain("can('REQUESTS_READ') ? (");
  });

  it('/users/new and /roles*: the super admin alone', () => {
    for (const path of ['app/users/new/page.tsx', 'app/roles/page.tsx', 'app/roles/[id]/page.tsx']) {
      const source = read(path);
      expect(source, path).toContain('await requireSuperAdmin()');
      expect(source, path).not.toContain('requireAdmin(');
    }
  });

  it('/users/[id]: ADMIN_USERS_READ; status behind ADMIN_USERS_STATUS; invite and roles for a super admin viewer', () => {
    const source = read('app/users/[id]/page.tsx');
    expect(source).toContain("requireAdmin('ADMIN_USERS_READ')");
    expect(source).toContain("const canChangeStatus = can('ADMIN_USERS_STATUS')");
    expect(source).toContain('const showStatusControl = canChangeStatus && !(isSelf && user.isActive)');
    expect(source).toContain('const roleState = isSuperAdminViewer');
    expect(source).toContain('{isSuperAdminViewer ? <AdminInviteSection user={user} /> : null}');
    expect(source).toContain('<ConfirmDialog');

    const card = read('app/users/[id]/role-assignment-card.tsx');
    expect(card).toContain('if (!isSuperAdminViewer || !roles) {');
    expect(card).toContain('<form action={revokeAdminRoleAction}');
    expect(card).toContain('<ConfirmDialog');
  });
});
