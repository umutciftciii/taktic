import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  PackagePurchase,
  ProviderCredits,
  statusLabel,
  formatPrice,
  formatDate,
} from '../../../../lib/api';
import { ProviderShell } from '../../provider-shell';
import { providerStatusBadgeClass } from '../../provider-ui';

type ProviderPackagePurchasesPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
};

export default async function ProviderPackagePurchasesPage({
  params,
  searchParams,
}: ProviderPackagePurchasesPageProps) {
  const { id } = await params;
  const { q } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/package-purchases`);
  }

  const [purchasesResult, creditsResult] = await Promise.allSettled([
    apiFetch<PackagePurchase[]>(`/providers/${id}/package-purchases`),
    apiFetch<ProviderCredits>(`/providers/${id}/credits`),
  ]);

  if (purchasesResult.status === 'rejected') {
    throw purchasesResult.reason;
  }

  const purchases = purchasesResult.value;
  const credits = creditsResult.status === 'fulfilled' ? creditsResult.value : null;

  const allPurchases = [...purchases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const searchQuery = (q ?? '').trim().toLocaleLowerCase('tr-TR');
  const filteredPurchases = searchQuery
    ? allPurchases.filter((p) => {
        const haystack = [
          p.packageNameSnapshot,
          p.purchaseNumber ?? '',
          p.mockPaymentReference ?? '',
        ]
          .join(' ')
          .toLocaleLowerCase('tr-TR');
        return haystack.includes(searchQuery);
      })
    : allPurchases;

  const paidPurchases = allPurchases.filter((p) => p.status === 'PAID');
  const totalCreditsLoaded = paidPurchases.reduce((sum, p) => sum + p.creditAmountSnapshot, 0);

  const spendByCurrency = paidPurchases.reduce<Record<string, number>>((acc, p) => {
    const cur = p.currencySnapshot || 'TRY';
    acc[cur] = (acc[cur] ?? 0) + p.priceAmountSnapshot;
    return acc;
  }, {});
  const currencyEntries = Object.entries(spendByCurrency);
  const totalSpendDisplay =
    currencyEntries.length === 0
      ? formatPrice(0)
      : currencyEntries.length === 1
        ? formatPrice(currencyEntries[0]![1], currencyEntries[0]![0])
        : 'Çoklu para birimi';
  const totalSpendHint =
    currencyEntries.length > 1
      ? currencyEntries.map(([cur, amount]) => formatPrice(amount, cur)).join(' · ')
      : paidPurchases.length === 0
        ? 'Ödenmiş satın alma yok'
        : 'Ödenmiş paketler toplamı';

  return (
    <ProviderShell user={user} providerId={id} active="packages">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Paket Geçmişim</span>
      </p>

      <header
        className="pdash-page-head"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h1 className="pdash-page-title">Paket Satın Alma Geçmişi</h1>
          <p className="pdash-page-sub">
            Önceki paket satın alımlarınızı ve fatura detaylarınızı buradan görüntüleyin.
          </p>
        </div>
        <span
          className="pdash-btn pdash-btn-secondary"
          role="button"
          aria-disabled="true"
          title="Yakında"
        >
          <span aria-hidden="true">⬇</span> Tümünü İndir
        </span>
      </header>

      <section className="pdash-stat-grid" aria-label="Paket geçmişi özetleri">
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Toplam Harcama</span>
          <span className="pdash-stat-value">{totalSpendDisplay}</span>
          <span className="pdash-stat-hint">{totalSpendHint}</span>
        </div>
        {credits ? (
          <div className="pdash-stat-card">
            <span className="pdash-stat-label">Mevcut Kredi</span>
            <span className="pdash-stat-value">{credits.balance}</span>
            <span className="pdash-stat-hint">Kullanılabilir durumda</span>
          </div>
        ) : null}
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Toplam Yüklenen Kredi</span>
          <span className="pdash-stat-value">{totalCreditsLoaded}</span>
          <span className="pdash-stat-hint">Ödenmiş paketlerden gelen toplam</span>
        </div>
      </section>

      <form
        method="get"
        role="search"
        aria-label="Paket geçmişi araması"
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: 12,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 220,
            background: '#f8fafc',
            border: '1px solid var(--border)',
            borderRadius: 999,
            padding: '8px 14px',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          <span aria-hidden="true">🔍</span>
          <input
            name="q"
            defaultValue={q ?? ''}
            placeholder="Referans no veya paket ara..."
            style={{
              flex: 1,
              border: 0,
              background: 'transparent',
              font: 'inherit',
              color: 'var(--text)',
              outline: 'none',
              minWidth: 0,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {searchQuery ? (
            <Link
              className="pdash-btn pdash-btn-ghost pdash-btn-sm"
              href={`/providers/${id}/package-purchases`}
            >
              Temizle
            </Link>
          ) : null}
          <button className="pdash-btn pdash-btn-primary pdash-btn-sm" type="submit">
            Ara
          </button>
          <span
            className="pdash-btn pdash-btn-secondary pdash-btn-sm"
            role="button"
            aria-disabled="true"
            title="Yakında"
          >
            <span aria-hidden="true">☰</span> Filtrele
          </span>
          <span
            className="pdash-btn pdash-btn-secondary pdash-btn-sm"
            role="button"
            aria-disabled="true"
            title="Yakında"
          >
            <span aria-hidden="true">📅</span> Tarih
          </span>
        </div>
      </form>

      {allPurchases.length === 0 ? (
        <div className="pdash-empty">
          <h3>Henüz paket satın alma geçmişiniz yok</h3>
          <p>Paket satın aldığınızda işlemler burada listelenecek.</p>
          <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/credits`}>
            Kredilerim &amp; Paketler
          </Link>
        </div>
      ) : (
        <section className="pdash-table-card">
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Paket Detayı</th>
                  <th>Referans No</th>
                  <th>Durum</th>
                  <th>Tutar</th>
                  <th style={{ textAlign: 'right' }}>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filteredPurchases.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}
                    >
                      Arama kriterinize uyan satın alma yok.
                    </td>
                  </tr>
                ) : (
                  filteredPurchases.map((purchase) => {
                    const { date, time } = splitDateAndTime(purchase.createdAt);
                    const ref =
                      purchase.purchaseNumber ??
                      purchase.mockPaymentReference ??
                      '—';
                    return (
                      <tr key={purchase.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{date}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{time}</div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 700 }}>{purchase.packageNameSnapshot}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                            {purchase.creditAmountSnapshot} Kredi
                          </div>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12.5 }}>{ref}</td>
                        <td>
                          <span className={providerStatusBadgeClass(purchase.status)}>
                            {statusLabel(purchase.status)}
                          </span>
                        </td>
                        <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                        </td>
                        <td>
                          <div
                            className="pdash-actions"
                            style={{ justifyContent: 'flex-end' }}
                          >
                            {purchase.status === 'PENDING' ? (
                              <Link
                                className="pdash-btn pdash-btn-primary pdash-btn-sm"
                                href={`/providers/${id}/package-purchases/${purchase.id}/checkout`}
                              >
                                Ödemeye Devam Et
                              </Link>
                            ) : null}
                            <Link
                              className="pdash-btn pdash-btn-ghost pdash-btn-sm"
                              href={`/providers/${id}/package-purchases/${purchase.id}`}
                            >
                              Detay
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--border-2)',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            Toplam {filteredPurchases.length} kayıttan 1 - {filteredPurchases.length} arası
            gösteriliyor
          </div>
        </section>
      )}
    </ProviderShell>
  );
}

function splitDateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: formatDate(iso),
    time: d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
  };
}
