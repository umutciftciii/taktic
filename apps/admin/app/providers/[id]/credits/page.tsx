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
import { DetailHeader } from '../../../../components/detail-header';
import { SectionCard } from '../../../../components/section-card';
import type { SummaryItem } from '../../../../components/summary-strip';
import { CreditOperationForm } from './credit-operation-form';
import { TransactionsPanel } from './transactions-panel';

/**
 * Hizmet veren kredileri (#14), the detail template (ADMIN-DESIGN-001 Faz 3B;
 * the design's `manual` form and `providerDetail` credit tab, paket 2 `17`,
 * `27`).
 *
 * F4, as it stands: the page is FINANCE_LEDGER_READ and reads only staff
 * routes — `GET /admin/providers/:id/credits` on FINANCE_LEDGER_READ and
 * `…/entitlements` on PACKAGE_PURCHASES_READ (ADMIN-DESIGN-000). The provider
 * routes behind ProviderAccessGuard (owner or SUPER_ADMIN) are not called
 * and not widened. Granting and deducting are CREDITS_GRANT and
 * CREDITS_DEDUCT, each offered only when held and each refused by the API
 * otherwise (apps/api/test/admin-provider-credits-read.spec.ts).
 */
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

  const listedHint = transactions.length >= 20 ? 'Son 20 hareket içinde' : 'Listelenen hareketler içinde';
  const canReadProviders = can('PROVIDERS_READ');

  const facts: SummaryItem[] = [
    {
      label: 'Mevcut bakiye',
      value: String(credits.balance),
      tone: credits.balance > 0 ? 'neutral' : 'warning',
      testId: 'credits-fact-balance',
    },
    // CAMPAIGN-CREDIT-POLICY-001: how much of the balance a manual deduction may take.
    ...walletFacts(credits),
    { label: 'İşlem sayısı', value: String(transactions.length), note: listedHint },
    { label: 'Elle ekleme', value: String(totalGrant), note: listedHint },
    { label: 'Elle düşme', value: String(totalDeduct), note: listedHint },
  ];

  return (
    <main className="credit-ops-page">
      <DetailHeader
        back={
          canOpenProvider
            ? { href: `/providers/${id}`, label: provider.businessName }
            : canReadProviders
              ? { href: '/providers', label: 'Hizmet verenler' }
              : null
        }
        badges={
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
        }
        meta="Hizmet veren kredileri"
        title={provider.businessName}
        subtitle={`${provider.city}/${provider.district}`}
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
        facts={facts}
        factsLabel="Kredi özeti"
        testId="credits-header"
      />

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
          <div className="table-scroll" role="region" aria-label="Dönemsel paketler" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">Dönemsel paketler</caption>
              <thead>
                <tr>
                  <th scope="col">Paket</th>
                  <th scope="col">Dönem</th>
                  <th scope="col">Durum</th>
                  <th scope="col">Kalan / kapsam</th>
                  <th scope="col">Yenileme</th>
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
                businessName={provider.businessName}
                currentBalance={credits.balance}
                deductibleBalance={credits.walletBreakdown?.deductibleCredits ?? null}
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
              <li>
                Kayıtlar silinmez ve düzenlenmez; yanlış bir hareket ancak ters yönde yeni bir işlemle
                dengelenir. Kredi düşme önce onay ister.
              </li>
            </ul>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}

/**
 * The balance split for the header (CAMPAIGN-CREDIT-POLICY-001): paid credit,
 * campaign credit an admin deduction may take, campaign credit it may not, and
 * the deductible total — aggregates only, no lot or campaign named.
 */
function walletFacts(credits: AdminProviderCredits): SummaryItem[] {
  const wallet = credits.walletBreakdown;
  if (!wallet) {
    return [
      {
        label: 'Kesilebilir toplam',
        value: '—',
        tone: 'warning',
        note: 'bakiye tutarsız; kesinti yapılamaz',
        testId: 'credits-fact-deductible',
      },
    ];
  }
  return [
    { label: 'Ücretli', value: String(wallet.paidCredits), testId: 'credits-fact-paid' },
    { label: 'Kampanya — kesilebilir', value: String(wallet.promoDeductibleCredits), testId: 'credits-fact-promo-deductible' },
    {
      label: 'Kampanya — kesintiye kapalı',
      value: String(wallet.promoProtectedCredits),
      note: wallet.promoUnsweptExpiredCredits > 0 ? `+${wallet.promoUnsweptExpiredCredits} süresi dolmuş` : undefined,
      testId: 'credits-fact-promo-protected',
    },
    { label: 'Kesilebilir toplam', value: String(wallet.deductibleCredits), testId: 'credits-fact-deductible' },
  ];
}

