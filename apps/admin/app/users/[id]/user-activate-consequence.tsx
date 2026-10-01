/**
 * A permission named in a confirmation: its raw value and the panel's line for
 * it ("Kredi · ekleme"). Labelled by the server page, so this file needs no
 * `lib/api` and the client role form can render it too.
 */
export type LabelledPermission = { permission: string; label: string };

/**
 * What the account would hold again, as far as the viewer may see it.
 *
 * `null` when the viewer is not a super admin: the role lists are a root read
 * (`GET /admin/users/:id/roles`), so the dialog says what it cannot show
 * instead of guessing.
 */
export type ActivationScope = {
  activeRoles: { name: string; permissionCount: number }[];
  /** Live assignments to roles that are themselves inactive: they grant nothing. */
  inactiveRoleCount: number;
  permissionCount: number;
  critical: LabelledPermission[];
} | null;

/**
 * "Hesabı aktifleştir", said before it happens (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 *
 * Deactivation deletes nothing (users.service `updateStatus`): the password and
 * every role assignment stay, so switching the account back on returns it with
 * exactly the access it had — for a super admin, everything. That is the
 * consequence the old one-click button never said.
 */
export function UserActivateConsequence({
  displayName,
  isSuperAdminTarget,
  scope,
}: {
  displayName: string;
  isSuperAdminTarget: boolean;
  scope: ActivationScope;
}) {
  return (
    <>
      <p data-testid="user-activate-impact">
        <strong>{displayName}</strong> yeniden giriş yapabilir. Şifresi ve rol atamaları pasifken silinmediği için hesap,
        pasifleştirilmeden önceki yetkileriyle hemen geri döner.
      </p>
      {isSuperAdminTarget ? (
        <p data-testid="user-activate-super-admin">
          <strong>Bu bir süper yönetici hesabı.</strong> Tüm izinleri ve hiçbir role devredilemeyen kök yetkileri — rol
          tanımlama ve atama, personel hesabı açma, davet bağlantısı üretme — geri kazanır.
        </p>
      ) : scope === null ? (
        <p data-testid="user-activate-scope-hidden">
          Bu hesabın rollerini yalnız süper yöneticiler görebilir. Hesap, atanmış aktif rollerinin izinlerinin tamamını
          geri kazanır.
        </p>
      ) : scope.activeRoles.length === 0 ? (
        <p data-testid="user-activate-scope">
          Hesabın aktif rolü yok: giriş yapabilir ama panele giremez.
          {scope.inactiveRoleCount > 0
            ? ` ${scope.inactiveRoleCount} atanmış rolü pasif; o roller aktifleştirilirse izinleri de döner.`
            : ''}
        </p>
      ) : (
        <>
          <p data-testid="user-activate-scope">
            Geri kazanacağı yetki: {scope.activeRoles.length} aktif rolden toplam {scope.permissionCount} izin.
            {scope.inactiveRoleCount > 0 ? ` (${scope.inactiveRoleCount} atanmış rolü pasif; izin vermez.)` : ''}
          </p>
          <div className="confirm-change-list">
            <p className="confirm-change-title">Aktif roller</p>
            <ul>
              {scope.activeRoles.map((role) => (
                <li key={role.name}>
                  {role.name} ({role.permissionCount} izin)
                </li>
              ))}
            </ul>
          </div>
          {scope.critical.length > 0 ? (
            <div className="confirm-change-list" data-testid="user-activate-critical">
              <p className="confirm-change-title">Aralarındaki kritik izinler</p>
              <ul>
                {scope.critical.map((item) => (
                  <li key={item.permission}>
                    {item.label} <code>{item.permission}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <p>Hesap buradan yeniden pasifleştirilebilir.</p>
    </>
  );
}
