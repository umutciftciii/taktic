import Link from 'next/link';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { EmptyState } from '../../components/empty-state';
import {
  formatDateTime,
  listAdminPermissionCatalogue,
  listAdminRoles,
  requireAdmin,
} from '../../lib/api';
import { createAdminRoleAction } from './actions';
import { PermissionMatrix } from './permission-matrix';

type RolesPageProps = {
  searchParams: Promise<{ error?: string; ok?: string }>;
};

/**
 * Roles, for the super admin alone.
 *
 * There is no permission that opens this screen, and that is the point: the
 * authority to define authority is not part of the model it defines (RG-7
 * §12.1). `requireAdmin()` only establishes panel access; the API refuses a
 * non-super-admin on every call this page makes, so a staff account that
 * guesses the URL gets the "yetkiniz yok" page rather than an empty form.
 */
export default async function AdminRolesPage({ searchParams }: RolesPageProps) {
  await requireAdmin();
  const [{ error, ok }, roles, catalogue] = await Promise.all([
    searchParams,
    listAdminRoles(),
    listAdminPermissionCatalogue(),
  ]);

  return (
    <>
      <PageHeader
        title="Roller ve izinler"
        subtitle="Rolleri siz tanımlarsınız; izin listesi sabittir ve panelden genişletilemez."
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      {ok ? (
        <div className="notice notice-success" role="status">
          Rol kaydedildi.
        </div>
      ) : null}

      <SectionCard
        title="Tanımlı roller"
        subtitle="Pasif bir rol, onu taşıyan herkesten izinlerini aynı anda geri alır."
      >
        {roles.length === 0 ? (
          <EmptyState
            title="Henüz rol yok"
            description="Aşağıdaki formdan ilk rolü oluşturun; oluşturduktan sonra kullanıcı detayından atayabilirsiniz."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Rol</th>
                <th>Anahtar</th>
                <th>İzin</th>
                <th>Atanmış</th>
                <th>Durum</th>
                <th>Güncellenme</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <td>
                    <Link href={`/roles/${role.id}`}>{role.name}</Link>
                    {role.description ? <div className="muted">{role.description}</div> : null}
                  </td>
                  <td>
                    <code>{role.key}</code>
                  </td>
                  <td>{role.permissions.length}</td>
                  <td>{role.activeAssignmentCount}</td>
                  <td>
                    <span className={role.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                      {role.isActive ? 'Aktif' : 'Pasif'}
                    </span>
                  </td>
                  <td>{formatDateTime(role.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard
        title="Yeni rol"
        subtitle="Anahtar sonradan değiştirilemez ve yeniden kullanılamaz; ad ve açıklama her zaman düzenlenebilir."
      >
        <form action={createAdminRoleAction} className="compact-form">
          <div className="compact-field-grid">
            <label className="field field-12">
              <span>Anahtar *</span>
              <input name="key" required minLength={2} maxLength={64} pattern="[a-z][a-z0-9-]*" placeholder="operasyon" />
              <small className="muted">Küçük harf, rakam ve tire; harfle başlar. Sonradan değiştirilemez.</small>
            </label>
            <label className="field field-12">
              <span>Ad *</span>
              <input name="name" required minLength={2} maxLength={120} placeholder="Operasyon" />
            </label>
            <label className="field field-12">
              <span>Açıklama</span>
              <textarea name="description" rows={2} maxLength={500} />
            </label>
          </div>

          <p className="form-label" style={{ marginTop: 16, fontWeight: 600 }}>İzinler</p>
          <PermissionMatrix catalogue={catalogue.permissions} selected={[]} />

          <div className="form-actions">
            <button className="btn btn-primary" type="submit">
              Rolü oluştur
            </button>
          </div>
        </form>
      </SectionCard>
    </>
  );
}
