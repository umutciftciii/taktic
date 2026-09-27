import Link from 'next/link';
import { PageHeader } from '../components/page-header';
import { EmptyState } from '../components/empty-state';

export default function NotFound() {
  return (
    <main>
      <PageHeader
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Bulunamadı' }]}
        title="Kayıt bulunamadı"
        subtitle="Aradığınız kayıt silinmiş olabilir ya da bağlantı hatalı."
      />
      <section className="system-state" aria-label="Sayfa bulunamadı">
        <p className="system-state-kicker">404</p>
        <EmptyState
          title="Bu sayfa mevcut değil."
          description="Adresi kontrol edin veya listeye dönüp kaydı yeniden seçin."
          action={
            <Link className="btn btn-secondary btn-sm" href="/">
              Dashboard'a dön
            </Link>
          }
        />
      </section>
    </main>
  );
}
