import Link from 'next/link';
import { requireSuperAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { NewAdminUserForm } from './new-admin-user-form';

export default async function NewAdminUserPage() {
  // Creating a staff account is a root capability: `POST /users` is
  // SUPER_ADMIN-only and no permission delegates it (RG-7 §12.1). The page
  // says so itself rather than offering a form that the API refuses.
  const { can } = await requireSuperAdmin();

  return (
    <main className="user-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: can('DASHBOARD_READ') ? '/' : undefined },
          { label: 'Admin Kullanıcıları', href: '/users' },
          { label: 'Yeni' },
        ]}
        title="Yeni Admin Kullanıcısı"
        subtitle="Bir admin kullanıcısı oluşturun ve şifre belirleme bağlantısını manuel paylaşın."
        actions={
          <Link className="btn btn-ghost btn-sm" href="/users">
            ← Listeye dön
          </Link>
        }
      />
      <NewAdminUserForm />
    </main>
  );
}
