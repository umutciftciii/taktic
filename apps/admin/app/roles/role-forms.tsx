'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { diffPermissions, permissionLines, type PermissionGroup } from '../../lib/permission-model';
import { PermissionMatrix } from './permission-matrix';

type FormAction = (formData: FormData) => void | Promise<void>;

/** Who a change to this role reaches, from `GET /admin/roles/:id`'s live assignments. */
export type RoleReach = { holders: number; activeHolders: number };

/**
 * "Bu rolü taşıyan 3 hesap (2'si aktif)": the reach, as the dialogs say it.
 * Only the figures the role detail returned; no figure is written when there
 * is none to write.
 */
export function describeReach({ holders, activeHolders }: RoleReach): string {
  if (holders === 0) return 'Bu rol şu an hiçbir hesaba atanmış değil';
  return `Bu rolü taşıyan ${holders} hesap (${activeHolders} tanesi aktif)`;
}

/**
 * What saving the matrix will do, written from what the operator ticked and
 * what the role detail says about who holds it. Exported for the unit test.
 */
export function PermissionSaveConsequence({
  added,
  removed,
  nextCount,
  lines,
  reach,
  roleActive,
}: {
  added: string[];
  removed: string[];
  nextCount: number;
  lines: Map<string, string>;
  reach: RoleReach;
  roleActive: boolean;
}) {
  return (
    <>
      <p data-testid="role-permissions-diff">
        {added.length} izin eklenecek, {removed.length} izin kaldırılacak. Kayıttan sonra rol {nextCount} izin taşır;
        işaretli kutular rolün tamamı olur.
      </p>
      {added.length > 0 ? <PermissionChangeList title="Eklenecek" permissions={added} lines={lines} /> : null}
      {removed.length > 0 ? <PermissionChangeList title="Kaldırılacak" permissions={removed} lines={lines} /> : null}
      <p data-testid="role-permissions-impact">
        {roleActive
          ? reach.holders === 0
            ? `${describeReach(reach)}; kayıt kimsenin yetkisini değiştirmez.`
            : `${describeReach(reach)} kayıt anında bu izinlerle çalışmaya başlar; açık oturumlar bir sonraki isteklerinde yeni yetkiyi okur.`
          : `Rol pasif; kayıt şu an kimsenin yetkisini değiştirmez. ${describeReach(reach)}; rol yeniden aktifleştirilirse yeni izinler onlara uygulanır.`}
      </p>
      <p>Bir hesabın başka aktif bir rolünde de bulunan izinler o hesapta kalır. Değişiklik adınızla kayda geçer.</p>
    </>
  );
}

function PermissionChangeList({
  title,
  permissions,
  lines,
}: {
  title: string;
  permissions: string[];
  lines: Map<string, string>;
}) {
  return (
    <div className="confirm-change-list">
      <p className="confirm-change-title">{title}</p>
      <ul>
        {permissions.map((permission) => (
          <li key={permission}>
            {lines.get(permission) ?? permission} <code>{permission}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The role's permission matrix and its save (`PUT /admin/roles/:id/permissions`
 * through `replaceAdminRolePermissionsAction`, unchanged).
 *
 * "İzinleri kaydet" asks first (ADMIN-DESIGN-001 Faz 3G): the dialog lists what
 * is added and taken away, and how many accounts hold the role — the length of
 * the role's live assignment list, with how many of them are active — because
 * that consequence is invisible from the tick boxes. It stays closed while
 * nothing has changed, so a save always has something to confirm.
 */
export function RolePermissionsForm({
  roleId,
  groups,
  selected,
  reach,
  roleActive,
  action,
}: {
  roleId: string;
  groups: PermissionGroup[];
  selected: string[];
  reach: RoleReach;
  roleActive: boolean;
  action: FormAction;
}) {
  const [current, setCurrent] = useState<string[]>(selected);
  const lines = useMemo(() => permissionLines(groups), [groups]);
  const { added, removed } = diffPermissions(selected, current);
  const changed = added.length + removed.length > 0;

  return (
    <form action={action} className="compact-form compact-form-wide" data-testid="role-permissions-form">
      <input type="hidden" name="roleId" value={roleId} />
      <PermissionMatrix groups={groups} selected={selected} onSelectionChange={setCurrent} testId="role-permission-matrix" />
      <div className="detail-form-footer">
        <p className="detail-form-footer-note" aria-live="polite" data-testid="role-permissions-pending">
          {changed
            ? `Kaydedilmemiş değişiklik: ${added.length} izin eklenecek, ${removed.length} izin kaldırılacak.`
            : 'Değişiklik yok. İşaretli kutular rolün şu anki izinleridir.'}
        </p>
        <div className="detail-form-footer-actions">
          <button className="btn btn-secondary" type="reset">
            Vazgeç
          </button>
          <ConfirmDialog
            triggerLabel="İzinleri kaydet"
            triggerClassName="btn btn-primary"
            tone="primary"
            title="Rolün izinleri değiştirilsin mi?"
            consequence={
              <PermissionSaveConsequence
                added={added}
                removed={removed}
                nextCount={current.length}
                lines={lines}
                reach={reach}
                roleActive={roleActive}
              />
            }
            confirmLabel="Evet, izinleri kaydet"
            disabled={!changed}
            testId="role-permissions-save"
          />
        </div>
      </div>
    </form>
  );
}

/**
 * Pasifleştir / Aktifleştir for a role (`PATCH /admin/roles/:id { isActive }`
 * through `setAdminRoleActiveAction`, unchanged).
 *
 * Deactivating takes the role's permissions from everyone holding it at once,
 * so it asks first; the dialog replaces the old "I understand" checkbox and
 * says how many accounts hold the role. The action's own rule stays: a
 * deactivation without `confirm=on` is refused before any request. That field
 * is rendered only once this component has hydrated, and a hydrated trigger
 * submits only through the dialog, so a click that lands before JavaScript
 * runs is refused exactly as an unticked checkbox was.
 *
 * Reactivating gives the permissions back to the same accounts and is undone
 * by the same button, so it is a plain submit.
 */
export function RoleStatusForm({
  roleId,
  roleName,
  isActive,
  permissionCount,
  reach,
  action,
}: {
  roleId: string;
  roleName: string;
  isActive: boolean;
  permissionCount: number;
  reach: RoleReach;
  action: FormAction;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <form action={action} className="inline-form" data-testid="role-status-form">
      <input type="hidden" name="roleId" value={roleId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      {isActive ? (
        <>
          {hydrated ? <input type="hidden" name="confirm" value="on" /> : null}
          <ConfirmDialog
            triggerLabel="Rolü pasifleştir"
            triggerClassName="btn btn-destructive"
            title={`"${roleName}" pasifleştirilsin mi?`}
            consequence={
              <>
                <p data-testid="role-deactivate-impact">
                  {reach.holders === 0
                    ? `${describeReach(reach)}; pasifleştirmek kimsenin yetkisini değiştirmez.`
                    : `${describeReach(reach)} bu rolün ${permissionCount} iznini hemen kaybeder; açık oturumlar bir sonraki isteklerinde yetkisiz kalır. Başka aktif bir rolden gelen izinler kalır.`}
                </p>
                <p>
                  Pasif rol yeni atama kabul etmez. Atamalar silinmez: rol yeniden aktifleştirilirse aynı hesaplar izinlerini
                  geri alır. Değişiklik adınızla kayda geçer.
                </p>
              </>
            }
            confirmLabel="Evet, pasifleştir"
            testId="role-deactivate"
          />
        </>
      ) : (
        <button className="btn btn-primary" type="submit" data-testid="role-activate">
          Rolü aktifleştir
        </button>
      )}
    </form>
  );
}
