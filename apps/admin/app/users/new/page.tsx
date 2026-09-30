import Link from 'next/link';
import { requireSuperAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { NewAdminUserForm } from './new-admin-user-form';

/**
 * A new staff account (#49, ADMIN-DESIGN-001 Faz 3G). The design has no screen
 * for it; it is built on the form template: a way back to the list, the title
 * with its ⓘ, and the form, whose three fields and action are unchanged.
 */
export default async function NewAdminUserPage() {
  // Creating a staff account is a root capability: `POST /users` is
  // SUPER_ADMIN-only and no permission delegates it (RG-7 §12.1). The page
  // says so itself rather than offering a form that the API refuses.
  await requireSuperAdmin();

  return (
    <main className="system-page system-form-page user-new-page">
      <Link className="detail-back" href="/users">
        <span aria-hidden="true">‹</span> Yönetici hesapları
      </Link>
      <PageHeader
        title="Yeni admin kullanıcısı"
        subtitle="Bir personel hesabı oluşturun ve şifre belirleme bağlantısını kendiniz paylaşın."
        infoLabel="Yeni hesap nasıl açılır?"
        info={
          <span className="popover-list">
            <span>Hesap bir personel hesabıdır ve rol atanana kadar hiçbir yetkisi yoktur; giriş yapsa da panele giremez.</span>
            <span>Rol, hesap oluşturulduktan sonra kullanıcı detayındaki Roller kartından atanır.</span>
            <span>Şifre belirleme bağlantısı 72 saat geçerlidir ve yalnız oluşturulduğu anda bir kez gösterilir.</span>
            <span>Bağlantı e-postayla gönderilmez; WhatsApp, SMS veya e-postayla siz paylaşırsınız.</span>
          </span>
        }
      />
      <NewAdminUserForm />
    </main>
  );
}
