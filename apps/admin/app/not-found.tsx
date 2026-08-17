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
      <div className="table-card">
        <div style={{ padding: 18 }}>
          <EmptyState
            title="Bu sayfa mevcut değil."
            description="Adresi kontrol edin veya listeye dönüp kaydı yeniden seçin."
            action={
              <Link className="btn btn-secondary btn-sm" href="/">
                Dashboard'a dön
              </Link>
            }
          />
        </div>
      </div>
    </main>
  );
}
