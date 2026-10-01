import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { offerAcceptRecharge } from '../app/offers/[id]/offer-accept-recharge';
import { CreditGrantConsequence } from '../app/providers/[id]/credits/credit-grant-consequence';
import { CreditOperationForm } from '../app/providers/[id]/credits/credit-operation-form';
import { RoleActivateConsequence, RoleStatusForm } from '../app/roles/role-forms';
import { FirstApprovalConsequence } from '../app/showcase/reviews/[versionId]/first-approval-consequence';
import {
  isPlacementCancelNoteValid,
  PLACEMENT_CANCEL_NOTE_MIN_LENGTH,
} from '../app/showcase/placements/placement-cancel';
import { RoleAssignConsequence, RoleAssignForm, type AssignableRole } from '../app/users/[id]/role-assign-form';
import { UserActivateConsequence } from '../app/users/[id]/user-activate-consequence';
import {
  CRITICAL_PERMISSIONS,
  criticalPermissionsIn,
  permissionsGainedOnAssign,
} from '../lib/permission-model';

/**
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 — Faz 1.
 *
 * Pinned here: the five R4 actions that went straight through now ask first,
 * and each dialog says what really happens; the offer-accept dialog speaks of a
 * second charge exactly when the server would make one; a placement
 * cancellation cannot be sent without a reason; and the create forms offer a
 * live status only to a session holding the status permission.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const noop = () => undefined;

function schemaPermissions(): string[] {
  const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const body = schema.split('enum AdminPermission {')[1]!.split('}')[0]!;
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z_]+$/.test(line));
}

describe('A) Kredi ekle asks first', () => {
  it('draws the grant trigger as a confirmation, not a plain submit', () => {
    const markup = html(
      <CreditOperationForm providerId="p-1" businessName="Usta Klima" currentBalance={40} canGrant canDeduct={false} />,
    );
    expect(markup).toMatch(/<button type="submit"[^>]*aria-haspopup="dialog"[^>]*data-testid="credit-operation-grant"/);
    expect(markup).toContain('data-testid="credit-operation-grant-dialog"');
    expect(markup).toContain('Kredi eklensin mi?');
    expect(markup).toContain('Evet, kredi ekle');
    // Nothing typed yet: the trigger is shut, as the plain button was.
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="credit-operation-grant"/);
  });

  it('says the business, the amount, the balance before and after, the reason, and that the row is permanent', () => {
    const said = html(
      <CreditGrantConsequence
        businessName="Usta Klima"
        amount={1500}
        balanceBefore={40}
        balanceAfter={1540}
        reason="  Telafi: hatalı düşüm  "
      />,
    );
    expect(said).toContain('Usta Klima');
    expect(said).toContain('1.500 kredi');
    expect(said).toContain('40 → 1.540');
    expect(said).toContain('“Telafi: hatalı düşüm”');
    expect(said).toContain('kalıcı bir kayıt');
    expect(said).toContain('silinemez');
    expect(said).toContain('ayrı bir kredi düşme işlemiyle dengelenebilir');
  });

  it('keeps the reason required on the form and leaves the action untouched', () => {
    const source = read('app/providers/[id]/credits/credit-operation-form.tsx');
    expect(source).toContain('minLength={REASON_MIN_LENGTH}');
    expect(source).toContain('const REASON_MIN_LENGTH = 3;');
    expect(source).toContain('<form action={formAction}');
  });
});

describe('B) Hesabı aktifleştir asks first, and only a super admin sees it on a super admin', () => {
  it('names the account and says it returns with its old access', () => {
    const said = html(<UserActivateConsequence displayName="Ayşe" isSuperAdminTarget={false} scope={null} />);
    expect(said).toContain('Ayşe');
    expect(said).toContain('yeniden giriş yapabilir');
    expect(said).toContain('pasifleştirilmeden önceki yetkileriyle');
  });

  it('says plainly when the target is a super admin', () => {
    const said = html(<UserActivateConsequence displayName="Kök" isSuperAdminTarget scope={null} />);
    expect(said).toContain('Bu bir süper yönetici hesabı.');
    expect(said).toContain('Tüm izinleri');
    expect(said).toContain('rol tanımlama ve atama');
  });

  it('lists the active roles, the permission total and the critical ones it would regain', () => {
    const said = html(
      <UserActivateConsequence
        displayName="Ayşe"
        isSuperAdminTarget={false}
        scope={{
          activeRoles: [
            { name: 'Finans', permissionCount: 4 },
            { name: 'Destek', permissionCount: 2 },
          ],
          inactiveRoleCount: 1,
          permissionCount: 5,
          critical: [{ permission: 'CREDITS_GRANT', label: 'Kredi · ekleme' }],
        }}
      />,
    );
    expect(said).toContain('2 aktif rolden toplam 5 izin');
    expect(said).toContain('Finans (4 izin)');
    expect(said).toContain('Destek (2 izin)');
    expect(said).toContain('1 atanmış rolü pasif');
    expect(said).toContain('Aralarındaki kritik izinler');
    expect(said).toContain('<code>CREDITS_GRANT</code>');
  });

  it('says an account with no active role still cannot reach the panel', () => {
    const said = html(
      <UserActivateConsequence
        displayName="Ayşe"
        isSuperAdminTarget={false}
        scope={{ activeRoles: [], inactiveRoleCount: 0, permissionCount: 0, critical: [] }}
      />,
    );
    expect(said).toContain('panele giremez');
  });

  it('says what it cannot show to a viewer who may not read roles', () => {
    const said = html(<UserActivateConsequence displayName="Ayşe" isSuperAdminTarget={false} scope={null} />);
    expect(said).toContain('rollerini yalnız süper yöneticiler görebilir');
  });

  it('the page asks before activating, keeps the deactivation dialog, and hides the switch on a super admin from anyone else', () => {
    const source = read('app/users/[id]/page.tsx');
    expect(source).toMatch(/<ConfirmDialog\s+proof="user.status"\s+triggerLabel="Hesabı aktifleştir"/);
    expect(source).toContain('testId="user-activate"');
    expect(source).toMatch(/<ConfirmDialog\s+proof="user.status"\s+triggerLabel="Hesabı pasifleştir"/);
    expect(source).toContain("const superAdminTargetLocked = isSuperAdminTarget && !isSuperAdminViewer;");
    expect(source).toContain(
      'const showStatusControl = canChangeStatus && !(isSelf && user.isActive) && !superAdminTargetLocked;',
    );
    expect(source).not.toContain('data-testid="user-activate"');
  });
});

const ROLE: AssignableRole = {
  id: 'r-1',
  name: 'Finans',
  permissionCount: 4,
  gainedCount: 3,
  criticalGained: [{ permission: 'CREDITS_GRANT', label: 'Kredi · ekleme' }],
};

describe('C) Rol ata asks first and never starts on a role', () => {
  it('starts the select on an empty, disabled "Rol seçin" and keeps the trigger shut', () => {
    const markup = html(<RoleAssignForm userId="u-1" accountName="Ayşe" roles={[ROLE]} action={noop} />);
    expect(markup).toMatch(/<select name="roleId" required=""[^>]*>/);
    expect(markup).toMatch(/<option value="" disabled="" selected="">Rol seçin…<\/option>/);
    expect(markup).not.toMatch(/<option value="r-1" selected=""/);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="user-role-assign-submit"/);
    expect(markup).toContain('<input type="hidden" name="userId" value="u-1"/>');
  });

  it('names the account, the role, its size, what is new and which new permissions are critical', () => {
    const said = html(<RoleAssignConsequence accountName="Ayşe" role={ROLE} />);
    expect(said).toContain('Ayşe');
    expect(said).toContain('“Finans”');
    expect(said).toContain('Rol 4 izin taşır');
    expect(said).toContain('3 yeni izni hemen kazanır (1 tanesi başka bir rolünden zaten var)');
    expect(said).toContain('Kazanacağı kritik izinler');
    expect(said).toContain('<code>CREDITS_GRANT</code>');
    expect(said).toContain('kayda geçer');
  });

  it('says when a role adds nothing the account does not already have', () => {
    const said = html(
      <RoleAssignConsequence accountName="Ayşe" role={{ ...ROLE, gainedCount: 0, criticalGained: [] }} />,
    );
    expect(said).toContain('bugünkü yetkisi değişmez');
    expect(said).not.toContain('Kazanacağı kritik izinler');
  });

  it('the card hands the form what the account would gain, from its own assignments', () => {
    const source = read('app/users/[id]/role-assignment-card.tsx');
    expect(source).toContain('permissionsGainedOnAssign(assigned.assignments, role.permissions)');
    expect(source).toContain('action={assignAdminRoleAction}');
  });
});

describe('D) Rolü aktifleştir asks first', () => {
  it('says the role, its size, how many accounts hold it and how many are active, and that they regain it', () => {
    const markup = html(
      <RoleStatusForm
        roleId="role-1"
        roleName="Destek"
        isActive={false}
        permissionCount={7}
        reach={{ holders: 4, activeHolders: 3 }}
        criticalPermissions={[{ permission: 'CREDITS_DEDUCT', label: 'Kredi · düşme' }]}
        action={noop}
      />,
    );
    expect(markup).toContain('&quot;Destek&quot; aktifleştirilsin mi?');
    expect(markup).toContain('Bu rolü taşıyan 4 hesap (3 tanesi aktif) bu rolün 7 iznini hemen geri kazanır');
    expect(markup).toContain('<code>CREDITS_DEDUCT</code>');
  });

  it('says a role nobody holds changes nobody', () => {
    const said = html(
      <RoleActivateConsequence permissionCount={2} reach={{ holders: 0, activeHolders: 0 }} criticalPermissions={[]} />,
    );
    expect(said).toContain('kimsenin yetkisini değiştirmez');
    expect(said).toContain('Rol 2 izin taşır');
  });
});

describe('E) the first vitrin approval asks first; a revision does not (Faz 4)', () => {
  it('says the right is spent, the card goes live, the provider is told and nothing undoes it', () => {
    const said = html(
      <FirstApprovalConsequence
        businessName="Usta Klima"
        entitlement={{ packageName: 'Vitrin 30', durationDays: 30 }}
      />,
    );
    expect(said).toContain('Yayın hakkı tüketilir');
    expect(said).toContain('Vitrin 30 paketinden gelen 30 günlük hak');
    expect(said).toContain('Kart yayına girer');
    expect(said).toContain('e-posta gider');
    expect(said).toContain('Karar geri alınamaz');
    expect(said).toContain('tüketilen hak iade edilmez');
  });

  it('the page wraps only the first approval, and the rejection keeps its dialog', () => {
    const source = read('app/showcase/reviews/[versionId]/page.tsx');
    expect(source).toMatch(/\{card\.liveVersion === null \? \([\s\S]*?<ConfirmDialog\s+proof="showcase.approve-first"\s+triggerLabel="Onayla"/);
    expect(source).toContain('testId="showcase-approve"');
    expect(source).toMatch(/<button className="btn btn-primary btn-sm" type="submit" disabled=\{!isPending\}>\s*Onayla/);
    expect(source).toContain('testId="showcase-reject"');
  });
});

describe('offer accept: the second charge is said exactly when the server makes it', () => {
  const base = { creditCost: 3, creditRefundedTransactionId: null, creditRechargeTransactionId: null };

  it('charges again only a refunded, paid, not-yet-recharged offer', () => {
    expect(offerAcceptRecharge(base)).toBeNull();
    expect(offerAcceptRecharge({ ...base, creditRefundedTransactionId: 'tx-r' })).toBe(3);
    expect(offerAcceptRecharge({ ...base, creditRefundedTransactionId: 'tx-r', creditCost: 0 })).toBeNull();
    expect(
      offerAcceptRecharge({ ...base, creditRefundedTransactionId: 'tx-r', creditRechargeTransactionId: 'tx-c' }),
    ).toBeNull();
  });

  it('the dialog adds the paragraph only then, with the amount', () => {
    const source = read('app/offers/[id]/page.tsx');
    expect(source).toContain('const recharge = offerAcceptRecharge(offer);');
    expect(source).toMatch(/\{recharge !== null \? \(\s*<p data-testid="offer-accept-recharge">/);
    expect(source).toContain('{recharge} kredi yeniden düşülür');
    expect(source).toContain('Kredi yeniden tahsil edilir');
  });
});

describe('placement cancel needs a reason', () => {
  it('judges the note trimmed, at the API minimum', () => {
    expect(PLACEMENT_CANCEL_NOTE_MIN_LENGTH).toBe(10);
    expect(isPlacementCancelNoteValid('')).toBe(false);
    expect(isPlacementCancelNoteValid('          ')).toBe(false);
    expect(isPlacementCancelNoteValid('   kısa   ')).toBe(false);
    expect(isPlacementCancelNoteValid('Müşteri şikâyeti')).toBe(true);
  });

  it('the field is required on the form and checked by the action before any request', () => {
    const page = read('app/showcase/placements/[placementId]/page.tsx');
    expect(page).toMatch(/<textarea\s+name="note"\s+required\s+minLength=\{PLACEMENT_CANCEL_NOTE_MIN_LENGTH\}/);
    expect(page).toContain('SHOWCASE_PLACEMENT_CANCEL_NOTE_REQUIRED');
    expect(page).toContain('Geri alınamaz');
    expect(page).toContain('Para iadesi yapılmaz.');
    const actions = read('app/showcase/placements/actions.ts');
    expect(actions).toMatch(/if \(!isPlacementCancelNoteValid\(note\)\) \{\s*redirect\(`\$\{target\}\?error=SHOWCASE_PLACEMENT_CANCEL_NOTE_REQUIRED`\)/);
  });
});

describe('create forms offer a live status only with the status permission', () => {
  it('credit package: inactive only without CREDIT_PACKAGES_STATUS', () => {
    const source = read('app/credit-packages/new/page.tsx');
    expect(source).toContain("const canChooseStatus = can('CREDIT_PACKAGES_STATUS');");
    expect(source).toContain("isActive: canChooseStatus && params.isActive !== 'false',");
    expect(source).toContain('<input type="hidden" name="isActive" value="false" />');
  });

  it('category: DRAFT only without CATEGORIES_STATUS', () => {
    const source = read('app/categories/new/page.tsx');
    expect(source).toContain("const canChooseStatus = can('CATEGORIES_STATUS');");
    expect(source).toContain('<input type="hidden" name="status" value="DRAFT" />');
  });
});

describe('critical permissions', () => {
  it('every entry is a real AdminPermission', () => {
    const catalogue = new Set(schemaPermissions());
    for (const permission of CRITICAL_PERMISSIONS) {
      expect(catalogue.has(permission), permission).toBe(true);
    }
  });

  it('picks the critical ones out of a set, and counts only what an assignment adds', () => {
    expect(criticalPermissionsIn(['SUPPORT_READ', 'CREDITS_GRANT'])).toEqual(['CREDITS_GRANT']);
    const held = [
      { revokedAt: null, role: { id: 'a', isActive: true, permissions: ['SUPPORT_READ'] } },
      { revokedAt: null, role: { id: 'b', isActive: false, permissions: ['CREDITS_GRANT'] } },
    ];
    expect(permissionsGainedOnAssign(held, ['SUPPORT_READ', 'CREDITS_GRANT'])).toEqual(['CREDITS_GRANT']);
  });
});
