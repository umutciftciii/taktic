import Link from 'next/link';
import {
  apiFetch,
  ProviderCredits,
  ProviderProfile,
  statusBadgeClass,
  statusLabel,
} from '../../../../lib/api';
import { PageHeader } from '../../../../components/page-header';
import { SectionCard } from '../../../../components/section-card';
import { StatCard } from '../../../../components/stat-card';
import { submitCreditOperationAction } from './actions';
import { CreditOperationForm } from './credit-operation-form';
import { TransactionsPanel } from './transactions-panel';

type AdminProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminProviderCreditsPage({ params }: AdminProviderCreditsPageProps) {
  const { id } = await params;

  const [credits, provider] = await Promise.all([
    apiFetch<ProviderCredits>(`/providers/${id}/credits`),
    apiFetch<ProviderProfile>(`/providers/${id}/admin-detail`),
  ]);

  const transactions = credits.transactions;
  const totalGrant = transactions
    .filter((t) => t.type === 'ADMIN_GRANT')
    .reduce((sum, t) => sum + t.amount, 0);
  const totalDeduct = transactions
    .filter((t) => t.type === 'ADMIN_DEDUCT')
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  const listedHint = 'Listelenen işlemler içinde';

  return (
    <main className="credit-ops-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Hizmet Verenler', href: '/providers' },
          { label: provider.businessName, href: `/providers/${id}` },
          { label: 'Krediler' },
        ]}
        title="Hizmet Veren Kredileri"
        subtitle={
          <>
            <strong>{provider.businessName}</strong>
            <span className="muted">
              {' · '}
              <span className={statusBadgeClass(provider.status)}>
                {statusLabel(provider.status)}
              </span>
              {' · '}
              {provider.city}/{provider.district}
            </span>
          </>
        }
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href={`/providers/${id}`}>
              Hizmet veren detayı
            </Link>
            <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${id}`}>
              Teklifler
            </Link>
          </>
        }
      />

      <section className="stat-grid">
        <StatCard
          label="Mevcut bakiye"
          value={credits.balance}
          tone={credits.balance > 0 ? 'neutral' : 'warning'}
        />
        <StatCard label="İşlem sayısı" value={transactions.length} hint={listedHint} />
        <StatCard label="Manuel ekleme" value={totalGrant} hint={listedHint} />
        <StatCard label="Manuel düşme" value={totalDeduct} hint={listedHint} />
      </section>

      <div className="credit-ops-grid">
        <SectionCard
          title="İşlem geçmişi"
          subtitle={`Toplam ${transactions.length} kayıt`}
          padded={false}
          className="credit-ops-history"
        >
          <TransactionsPanel transactions={transactions} />
        </SectionCard>

        <div className="credit-ops-side">
          <SectionCard
            title="Manuel kredi işlemi"
            subtitle="Ekle veya düş — tek formdan"
            className="credit-operation-card"
          >
            <CreditOperationForm
              providerId={id}
              currentBalance={credits.balance}
              action={submitCreditOperationAction}
            />
          </SectionCard>

          <SectionCard title="Denetim notu" className="credit-ops-audit">
            <ul className="credit-ops-audit-list">
              <li>
                Manuel işlemlerde sebep alanı zorunludur ve kredi hareketleri ile birlikte saklanır.
              </li>
              <li>
                İşlemi yapan yöneticinin kaydı tutulur ve geçmiş listede &quot;Yapan&quot;
                sütununda görünür.
              </li>
              <li>
                Eski tarihli bazı kayıtlarda işlemi yapan bilgisi bulunmayabilir; bu kayıtlar
                &quot;—&quot; olarak görünür.
              </li>
              <li>Negatif bakiyeye düşüren işlemler sunucu tarafında reddedilir.</li>
            </ul>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
