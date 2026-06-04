import Link from 'next/link';
import {
  apiFetch,
  creditTxnTypeLabel,
  FinanceSummary,
  formatDateTime,
  formatPrice,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { StatCard } from '../../components/stat-card';

export default async function AdminFinanceDashboardPage() {
  await requireAdmin();
  const summary = await apiFetch<FinanceSummary>('/finance/summary');

  const { revenue, packagePurchases, credits, recentTransactions, recentPurchases } = summary;

  return (
    <main>
      <PageHeader
        title="Finans"
        subtitle="Tahsilat, kredi hareketleri ve paket talep durumlarına dair özet."
        actions={
          <>
            <Link className="btn btn-secondary btn-sm" href="/finance/credit-ledger">
              Kredi Hareketleri
            </Link>
            <Link className="btn btn-secondary btn-sm" href="/package-purchases">
              Paket Satın Almaları
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/refund-scan">
              İade Taraması
            </Link>
          </>
        }
      />

      <SectionCard title="Tahsilat" subtitle="Ödenmiş paketlerden gelen toplam gelir.">
        <div className="stat-grid">
          <StatCard label="Toplam tahsilat" value={formatPrice(revenue.totalRevenuePaid)} />
          <StatCard label="Bugünkü tahsilat" value={formatPrice(revenue.todayRevenuePaid)} />
          <StatCard label="Bu ay tahsilat" value={formatPrice(revenue.monthRevenuePaid)} />
        </div>
      </SectionCard>

      <SectionCard title="Kredi hareketleri" subtitle="Tüm zaman toplamları ve sistem geneli aktif bakiye.">
        <div className="stat-grid">
          <StatCard label="Satılan kredi" value={credits.totalCreditsSold} />
          <StatCard label="Harcanan kredi" value={credits.totalCreditsSpent} />
          <StatCard
            label="İade edilen kredi"
            value={credits.totalCreditsRefunded}
            tone={credits.totalCreditsRefunded > 0 ? 'warning' : 'neutral'}
          />
          <StatCard label="Manuel eklenen kredi" value={credits.totalCreditsAdminGranted} />
          <StatCard
            label="Manuel düşülen kredi"
            value={credits.totalCreditsAdminDeducted}
            tone={credits.totalCreditsAdminDeducted > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="Aktif provider kredi bakiyesi"
            value={credits.totalActiveProviderCreditBalance}
            hint="Tüm hizmet verenlerin son bakiyelerinin toplamı"
            tone="success"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Paket talep durumları"
        subtitle={`Toplam ${packagePurchases.totalPackagePurchases} kayıt`}
      >
        <div className="stat-grid">
          <StatCard
            label="Ödenmiş"
            value={packagePurchases.paidPackagePurchases}
            href="/package-purchases?status=PAID"
            tone="success"
          />
          <StatCard
            label="Bekleyen"
            value={packagePurchases.pendingPackagePurchases}
            href="/package-purchases?status=PENDING"
            tone={packagePurchases.pendingPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
          <StatCard
            label="İptal"
            value={packagePurchases.cancelledPackagePurchases}
            href="/package-purchases?status=CANCELLED"
          />
          <StatCard
            label="Başarısız"
            value={packagePurchases.failedPackagePurchases}
            href="/package-purchases?status=FAILED"
            tone={packagePurchases.failedPackagePurchases > 0 ? 'error' : 'neutral'}
          />
          <StatCard
            label="Süresi dolmuş"
            value={packagePurchases.expiredPackagePurchases}
            href="/package-purchases?status=EXPIRED"
          />
          <StatCard
            label="İade edilmiş"
            value={packagePurchases.refundedPackagePurchases}
            href="/package-purchases?status=REFUNDED"
            tone={packagePurchases.refundedPackagePurchases > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Son kredi hareketleri"
        subtitle={`En son ${recentTransactions.length} işlem`}
        padded={false}
      >
        {recentTransactions.length === 0 ? (
          <EmptyState
            title="Henüz kredi hareketi yok"
            description="Paket ödendiğinde, teklif gönderildiğinde veya manuel işlem yapıldığında burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Hizmet Veren</th>
                  <th>Tip</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Bakiye</th>
                  <th>Sebep</th>
                  <th>Kaynak</th>
                </tr>
              </thead>
              <tbody>
                {recentTransactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDateTime(transaction.createdAt)}</td>
                    <td>
                      <Link href={`/providers/${transaction.providerId}/credits`}>
                        {transaction.provider.businessName}
                      </Link>
                    </td>
                    <td>{creditTxnTypeLabel(transaction.type)}</td>
                    <td className="col-num">
                      <strong>
                        {transaction.amount > 0 ? `+${transaction.amount}` : transaction.amount}
                      </strong>
                    </td>
                    <td className="col-num">{transaction.balanceAfter}</td>
                    <td>{transaction.reason ?? '-'}</td>
                    <td>
                      {transaction.referenceType ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {transaction.referenceType}
                          {transaction.referenceId ? ` · ${transaction.referenceId}` : ''}
                        </span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Son paket satın almaları"
        subtitle={`En son ${recentPurchases.length} kayıt`}
        padded={false}
      >
        {recentPurchases.length === 0 ? (
          <EmptyState
            title="Henüz paket satın alma yok"
            description="Hizmet verenler paket aldıkça burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Hizmet Veren</th>
                  <th>Paket</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Tutar</th>
                  <th>Durum</th>
                  <th>Ödeme Referansı</th>
                </tr>
              </thead>
              <tbody>
                {recentPurchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>{formatDateTime(purchase.createdAt)}</td>
                    <td>
                      <Link href={`/providers/${purchase.providerId}`}>
                        {purchase.provider.businessName}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/package-purchases/${purchase.id}`}>
                        {purchase.packageNameSnapshot}
                      </Link>
                    </td>
                    <td className="col-num">{purchase.creditAmountSnapshot}</td>
                    <td className="col-num">
                      {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                    </td>
                    <td>
                      <span className={statusBadgeClass(purchase.status)}>
                        {statusLabel(purchase.status)}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {purchase.mockPaymentReference ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Hızlı bağlantılar" subtitle="Sık kullanılan finans ekranları.">
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" href="/finance/credit-ledger">
            Kredi Hareketleri
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/finance/manual-adjustments">
            Manuel İşlemler
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/finance/providers">
            Provider Finans Bakiyeleri
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/package-purchases">
            Paket Satın Almaları
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/refund-scan">
            İade Taraması
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/credit-packages">
            Kredi Paketleri
          </Link>
          <Link className="btn btn-ghost btn-sm" href="/providers">
            Hizmet Verenler
          </Link>
        </div>
      </SectionCard>
    </main>
  );
}
