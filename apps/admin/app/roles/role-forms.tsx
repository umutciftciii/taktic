'use client';

import { useMemo, useState } from 'react';
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
            proof="role.permissions"
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
 * and reactivating gives them back the same way, so both ask first and the
 * dialog says how many accounts hold the role. The action refuses either
 * direction without the dialog's single-use confirmation proof
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001), which replaced the hydrated
 * `confirm=on` field: a fixed value is not proof that anybody confirmed.
 */
export function RoleStatusForm({
  roleId,
  roleName,
  isActive,
  permissionCount,
  reach,
  criticalPermissions = [],
  action,
}: {
  roleId: string;
  roleName: string;
  isActive: boolean;
  permissionCount: number;
  reach: RoleReach;
  /** The role's critical permissions with their panel lines, for the reactivation dialog. */
  criticalPermissions?: { permission: string; label: string }[];
  action: FormAction;
}) {
  return (
    <form action={action} className="inline-form" data-testid="role-status-form">
      <input type="hidden" name="roleId" value={roleId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      {isActive ? (
        <>
          <ConfirmDialog
            proof="role.status"
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
        <ConfirmDialog
          proof="role.status"
          triggerLabel="Rolü aktifleştir"
          triggerClassName="btn btn-primary"
          tone="primary"
          title={`"${roleName}" aktifleştirilsin mi?`}
          consequence={
            <RoleActivateConsequence
              permissionCount={permissionCount}
              reach={reach}
              criticalPermissions={criticalPermissions}
            />
          }
          confirmLabel="Evet, aktifleştir"
          testId="role-activate"
        />
      )}
    </form>
  );
}

/**
 * What reactivating a role does (ADMIN-DESTRUCTIVE-CONFIRMATION-001): the
 * reverse of deactivation, and just as wide. Deactivating touched no
 * assignment row — the session read filters on `role.isActive` — so every
 * account still holding the role gets its permissions back at once, with the
 * permission set the role has *today* (it may have been edited while off).
 * Exported for the unit test.
 */
export function RoleActivateConsequence({
  permissionCount,
  reach,
  criticalPermissions,
}: {
  permissionCount: number;
  reach: RoleReach;
  criticalPermissions: { permission: string; label: string }[];
}) {
  return (
    <>
      <p data-testid="role-activate-impact">
        {reach.holders === 0
          ? `${describeReach(reach)}; aktifleştirmek bugün kimsenin yetkisini değiştirmez. Rol ${permissionCount} izin taşır ve yeniden atanabilir hale gelir.`
          : `${describeReach(reach)} bu rolün ${permissionCount} iznini hemen geri kazanır; açık oturumlar bir sonraki isteklerinde yeni yetkiyi okur. Pasif hesaplar da yeniden aktifleştirildiklerinde bu izinlerle döner.`}
      </p>
      {criticalPermissions.length > 0 ? (
        <div className="confirm-change-list" data-testid="role-activate-critical">
          <p className="confirm-change-title">Rolün kritik izinleri</p>
          <ul>
            {criticalPermissions.map((item) => (
              <li key={item.permission}>
                {item.label} <code>{item.permission}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>
        Geri dönen izinler rolün pasifken değiştirilmiş olabilecek bugünkü izin kümesidir. Rol yeniden yeni atama kabul
        eder. Değişiklik adınızla kayda geçer; rol buradan yeniden pasifleştirilebilir.
      </p>
    </>
  );
}
