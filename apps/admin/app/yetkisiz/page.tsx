import Link from 'next/link';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

/**
 * Where a staff account lands when it asks for something its roles do not
 * cover.
 *
 * Deliberately not the sign-in form. The person is signed in; signing in again
 * would change nothing and would read as "we lost your session" rather than
 * "this is not yours to do". It is also deliberately vague about *which*
 * permission is missing: naming it would draw a map of the panel for anybody
 * probing it, and the person who needs to know is the super admin who assigns
 * roles, not the browser.
 */
export const metadata = {
  title: 'Yetkiniz yok · TakTic Admin',
};

export default function ForbiddenPage() {
  return (
    <>
      <PageHeader
        title="Bu sayfa için yetkiniz yok"
        subtitle="Hesabınız yönetim paneline erişebiliyor, ancak bu bölüm atanmış rollerinizin kapsamı dışında."
      />

      <SectionCard title="Ne yapabilirsiniz?">
        <p>
          Bu bölüme erişmeniz gerekiyorsa, hesabınıza uygun rolün atanması için süper admin ile iletişime geçin.
          Rolünüz güncellendiğinde değişiklik bir sonraki sayfa açılışında geçerli olur; yeniden giriş yapmanız
          gerekmez.
        </p>

        <p style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <Link className="btn btn-primary btn-sm" href="/">
            Panele dön
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/login">
            Başka bir hesapla giriş yap
          </Link>
        </p>
      </SectionCard>
    </>
  );
}
