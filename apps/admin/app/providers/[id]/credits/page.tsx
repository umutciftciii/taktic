import Link from 'next/link';
import {
  AdminProviderEntitlements,
  apiFetch,
  formatDateTime,
  formatPrice,
  AdminProviderCredits,
  fetchOrNotFound,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../../lib/api';
import { PageHeader } from '../../../../components/page-header';
import { SectionCard } from '../../../../components/section-card';
import { StatCard } from '../../../../components/stat-card';
import { submitCreditOperationAction } from './actions';
import { CreditOperationForm } from './credit-operation-form';
import { TransactionsPanel } from './transactions-panel';

const PROVIDER_PACKAGE_TYPE_LABEL: Record<string, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota',
  CATEGORY_UNLIMITED: 'Kategori limitsiz',
};

const ENTITLEMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Aktif',
  EXPIRED: 'Süresi doldu',
  PAST_DUE: 'Ödeme alınamadı',
  CANCELLED: 'İptal edildi',
};

type AdminProviderCreditsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminProviderCreditsPage({ params }: AdminProviderCreditsPageProps) {
  const { can } = await requireAdmin('FINANCE_LEDGER_READ');
  const { id } = await params;
  // The provider-owner routes (`/providers/:id/credits`, `…/entitlements`)
  // admit the owner or a SUPER_ADMIN and nobody else. This screen reads the
  // staff routes instead: credits on FINANCE_LEDGER_READ (this page's gate),
  // periods on PACKAGE_PURCHASES_READ. The credits answer carries the
  // provider's label, so the header needs no PROVIDERS_READ_DETAIL.
  const canReadPeriods = can('PACKAGE_PURCHASES_READ');
  const canGrant = can('CREDITS_GRANT');
  const canDeduct = can('CREDITS_DEDUCT');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenOffers = can('OFFERS_READ');

  const [credits, entitlements] = await Promise.all([
    fetchOrNotFound(() => apiFetch<AdminProviderCredits>(`/admin/providers/${id}/credits`)),
    canReadPeriods
      ? apiFetch<AdminProviderEntitlements>(`/admin/providers/${id}/entitlements`)
      : Promise.resolve(null),
  ]);
  const provider = credits.provider;

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
          { label: 'Dashboard', href: can('DASHBOARD_READ') ? '/' : undefined },
          { label: 'Hizmet Verenler', href: can('PROVIDERS_READ') ? '/providers' : undefined },
          { label: provider.businessName, href: canOpenProvider ? `/providers/${id}` : undefined },
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
            {canOpenProvider ? (
              <Link className="btn btn-secondary btn-sm" href={`/providers/${id}`}>
                Hizmet veren detayı
              </Link>
            ) : null}
            {canOpenOffers ? (
              <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${id}`}>
                Teklifler
              </Link>
            ) : null}
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

      {entitlements ? (
      <SectionCard
        title="Dönemsel paketler"
        subtitle={
          entitlements.autoRenew.available
            ? `${entitlements.entitlements.length} kayıt`
            : `${entitlements.entitlements.length} kayıt · otomatik yenileme bu kurulumda kullanılamıyor`
        }
        padded={false}
      >
        {entitlements.entitlements.length === 0 ? (
          <p className="cell-muted" style={{ padding: 16 }}>
            Bu hizmet verenin aylık kota veya limitsiz paketi bulunmuyor.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Paket</th>
                  <th>Dönem</th>
                  <th>Durum</th>
                  <th>Kalan / kapsam</th>
                  <th>Yenileme</th>
                </tr>
              </thead>
              <tbody>
                {entitlements.entitlements.map((item) => {
                  const latestAttempt = item.renewalAttempts[0] ?? null;
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className="cell-stack">
                          <strong>{item.packageName}</strong>
                          <span className="cell-muted" style={{ fontSize: 12 }}>
                            {PROVIDER_PACKAGE_TYPE_LABEL[item.type] ?? item.type} ·{' '}
                            {formatPrice(item.priceAmount, item.currency)}
                          </span>
                          {item.purchaseNumber ? (
                            <span className="cell-muted" style={{ fontSize: 12 }}>
                              satın alma <code>{item.purchaseNumber}</code>
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="cell-muted">
                        {formatDateTime(item.startAt)} – {formatDateTime(item.endAt)}
                        <div style={{ fontSize: 12 }}>
                          {item.periodDays} gün · dönem #{item.periodIndex}
                        </div>
                      </td>
                      <td>
                        <span
                          className={
                            item.usable ? 'badge badge-good' : 'badge badge-muted'
                          }
                        >
                          {ENTITLEMENT_STATUS_LABEL[item.status] ?? item.status}
                        </span>
                        {item.queued ? (
                          <div className="cell-muted" style={{ fontSize: 12 }}>
                            sıraya alındı
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {item.type === 'MONTHLY_QUOTA'
                          ? `${item.quotaRemaining ?? 0} / ${item.quotaTotal ?? 0} kredi`
                          : item.scope.map((scope) => scope.name).join(', ') || '—'}
                        {item.type === 'CATEGORY_UNLIMITED' && item.dailyOfferLimit ? (
                          <div className="cell-muted" style={{ fontSize: 12 }}>
                            günlük limit {item.dailyOfferLimit}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span>
                            otomatik yenileme:{' '}
                            <strong>{item.autoRenewEnabled ? 'açık' : 'kapalı'}</strong>
                          </span>
                          <span className="cell-muted" style={{ fontSize: 12 }}>
                            kayıtlı ödeme yöntemi:{' '}
                            {item.paymentMethodOnFile ? 'var' : 'yok'}
                          </span>
                          {latestAttempt ? (
                            <span className="cell-muted" style={{ fontSize: 12 }}>
                              son deneme {formatDateTime(latestAttempt.attemptedAt)} ·{' '}
                              {latestAttempt.status}
                              {latestAttempt.failureCode ? ` (${latestAttempt.failureCode})` : ''}
                              {latestAttempt.providerTransactionRef ? (
                                <>
                                  {' '}
                                  · işlem <code>{latestAttempt.providerTransactionRef}</code>
                                </>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      ) : null}

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
          {canGrant || canDeduct ? (
            <SectionCard
              title="Manuel kredi işlemi"
              subtitle={
                canGrant && canDeduct
                  ? 'Ekle veya düş — tek formdan'
                  : canGrant
                    ? 'Kredi ekle'
                    : 'Kredi düş'
              }
              className="credit-operation-card"
            >
              <CreditOperationForm
                providerId={id}
                currentBalance={credits.balance}
                action={submitCreditOperationAction}
                canGrant={canGrant}
                canDeduct={canDeduct}
              />
            </SectionCard>
          ) : null}

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
