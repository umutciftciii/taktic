import Link from 'next/link';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { WholeListFooter } from '../../components/pagination';
import { formatDateTime, listAdminPermissionCatalogue, listAdminRoles, requireSuperAdmin } from '../../lib/api';
import { formatCount } from '../../lib/pagination';
import { groupPermissions } from '../../lib/permission-groups';
import { createAdminRoleAction } from './actions';
import { PermissionMatrix } from './permission-matrix';

type RolesPageProps = {
  searchParams: Promise<{ error?: string; ok?: string }>;
};

const COLUMNS: DataColumn[] = [
  { key: 'role', label: 'Rol' },
  { key: 'key', label: 'Anahtar' },
  { key: 'permissions', label: 'İzin', align: 'end' },
  { key: 'holders', label: 'Taşıyan hesap', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'updated', label: 'Güncellenme' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

/** The ⓘ: what a role is here, and what this screen will not do. */
const ROLES_SCREEN_INFO = (
  <span className="popover-list">
    <span>Bir personel hesabının yapabildiği her şey, ona atanmış aktif rollerin izinlerinin birleşimidir.</span>
    <span>İzin listesi sabittir; panelden izin eklenemez, yalnız rollere dağıtılır.</span>
    <span>Rol silinmez, pasifleştirilir: pasif rol kimseye izin vermez, atamaları kalır.</span>
    <span>Rol tanımlamak ve atamak yalnız süper yöneticilerdedir; hiçbir izin bu ekranı açmaz.</span>
  </span>
);

/**
 * Roles, for the super admin alone (#51, ADMIN-DESIGN-001 Faz 3G). The design
 * has no screen for it; it is built on the list template: the title with its
 * ⓘ and real counts, the role table, and the new-role form with the whole
 * permission catalogue grouped by area.
 *
 * There is no permission that opens this screen, and that is the point: the
 * authority to define authority is not part of the model it defines (RG-7
 * §12.1). `requireSuperAdmin()` sends any other staff account to the
 * "yetkiniz yok" page before anything renders; the API refuses the same calls
 * on its own, so the screen is not the only guard.
 *
 * Unchanged: `createAdminRoleAction` and the fields it reads (key, name,
 * description, permissions[]).
 */
export default async function AdminRolesPage({ searchParams }: RolesPageProps) {
  await requireSuperAdmin();
  const [{ error, ok }, roles, catalogue] = await Promise.all([
    searchParams,
    listAdminRoles(),
    listAdminPermissionCatalogue(),
  ]);
  const groups = groupPermissions(catalogue.permissions);
  const activeCount = roles.filter((role) => role.isActive).length;

  return (
    <main className="system-page roles-page">
      <PageHeader
        title="Roller ve izinler"
        subtitle={
          roles.length === 0
            ? `Henüz rol yok · izin kataloğunda ${formatCount(catalogue.permissions.length)} izin`
            : `${formatCount(roles.length)} rol · ${formatCount(activeCount)} aktif · izin kataloğunda ${formatCount(catalogue.permissions.length)} izin`
        }
        info={ROLES_SCREEN_INFO}
        infoLabel="Roller nasıl çalışır?"
        actions={
          <a className="btn btn-primary" href="#yeni-rol">
            Yeni rol tanımla
          </a>
        }
      />

      {error ? (
        <div className="notice notice-error detail-notice" role="alert">
          {error}
        </div>
      ) : null}
      {ok ? (
        <div className="notice notice-success detail-notice" role="status">
          Rol kaydedildi.
        </div>
      ) : null}

      <section className="data-list-card" aria-labelledby="role-list-title">
        <header className="data-list-card-head">
          <h2 id="role-list-title">Tanımlı roller</h2>
          <p className="cell-muted">Pasif bir rol, onu taşıyan herkesten izinlerini aynı anda geri alır.</p>
        </header>
        {roles.length === 0 ? (
          <EmptyState
            title="Henüz rol yok"
            description="Aşağıdaki formdan ilk rolü oluşturun; oluşturduktan sonra kullanıcı detayından atayabilirsiniz."
          />
        ) : (
          <DataTable caption="Tanımlı roller" columns={COLUMNS} minWidth={860} testId="role-table">
            {roles.map((role) => (
              <tr key={role.id} data-testid="role-row" data-role-id={role.id}>
                <td>
                  <div className="cell-stack">
                    <Link className="cell-link cell-break" href={`/roles/${role.id}`} id={`role-name-${role.id}`}>
                      <strong>{role.name}</strong>
                    </Link>
                    {role.description ? <span className="cell-muted cell-break">{role.description}</span> : null}
                  </div>
                </td>
                <td>
                  <code className="cell-break">{role.key}</code>
                </td>
                <td className="is-num">
                  {role.permissions.length}
                  <span className="cell-muted"> / {catalogue.permissions.length}</span>
                </td>
                <td className="is-num">{role.activeAssignmentCount}</td>
                <td>
                  <span className={role.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                    {role.isActive ? 'Aktif' : 'Pasif'}
                  </span>
                </td>
                <td className="cell-nowrap">{formatDateTime(role.updatedAt)}</td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`/roles/${role.id}`}
                    aria-describedby={`role-name-${role.id}`}
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {roles.length > 0 ? <WholeListFooter count={roles.length} noun="rol" /> : null}
      </section>

      <SectionCard
        id="yeni-rol"
        title="Yeni rol"
        subtitle="Anahtar sonradan değiştirilemez ve yeniden kullanılamaz; ad, açıklama ve izinler her zaman düzenlenebilir."
        className="detail-tab-card"
        testId="role-create-card"
      >
        <form action={createAdminRoleAction} className="compact-form compact-form-wide" data-testid="role-create-form">
          <div className="compact-field-grid">
            <label className="field field-4">
              <span>Anahtar *</span>
              <input
                name="key"
                required
                minLength={2}
                maxLength={64}
                pattern="[a-z][a-z0-9-]*"
                placeholder="operasyon"
                autoComplete="off"
              />
              <span className="help-text">Küçük harf, rakam ve tire; harfle başlar. Sonradan değiştirilemez.</span>
            </label>
            <label className="field field-4">
              <span>Ad *</span>
              <input name="name" required minLength={2} maxLength={120} placeholder="Operasyon" />
            </label>
            <label className="field field-12">
              <span>Açıklama</span>
              <textarea name="description" rows={2} maxLength={500} />
            </label>
          </div>

          <h3 className="form-section-title">İzinler</h3>
          <PermissionMatrix groups={groups} selected={[]} testId="role-create-matrix" />

          <div className="detail-form-footer">
            <p className="detail-form-footer-note">
              Rol oluşturulunca kimseye atanmış olmaz; atama kullanıcı detayındaki Roller kartından yapılır.
            </p>
            <div className="detail-form-footer-actions">
              <button className="btn btn-secondary" type="reset">
                Vazgeç
              </button>
              <button className="btn btn-primary" type="submit">
                Rolü oluştur
              </button>
            </div>
          </div>
        </form>
      </SectionCard>
    </main>
  );
}
