import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  PACKAGE_REFUND_EXCEPTION_GROUND_LABELS,
  PACKAGE_REFUND_RECOMMENDATION_LABELS,
  PACKAGE_REFUND_STATUS_LABELS,
  PACKAGE_REFUND_STATUSES,
  packageRefundStatusBadgeClass,
  requireAdmin,
  type PackageRefundListResponse,
  type PackageRefundRequestStatus,
} from '../../lib/api';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

type PageProps = { searchParams: Promise<{ status?: string; page?: string }> };

const PAGE_SIZE = 25;

/**
 * CMP-006 PR-B — the package refund queue.
 *
 * What a row carries is what the API's allowlist projection carries: the
 * provider's business name, the purchase summary, the status and how the
 * request was opened. No client address, user agent, terms text or digest, and
 * no payment reference — those never leave the API on this surface.
 */
export default async function PackageRefundsPage({ searchParams }: PageProps) {
  await requireAdmin('PACKAGE_REFUND_READ');
  const params = await searchParams;
  const status = PACKAGE_REFUND_STATUSES.includes(params.status as PackageRefundRequestStatus)
    ? (params.status as PackageRefundRequestStatus)
    : null;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) query.set('status', status);
  const response = await apiFetch<PackageRefundListResponse>(`/admin/package-refund-requests?${query.toString()}`);

  const href = (nextPage: number) => {
    const next = new URLSearchParams({ page: String(nextPage) });
    if (status) next.set('status', status);
    return `/package-refunds?${next.toString()}`;
  };

  return (
    <main>
      <PageHeader
        title="Paket İadeleri"
        subtitle="Hizmet verenlerin destek talebiyle açtığı paket ödeme iadesi istekleri. Para iadesi ödeme sağlayıcısının panelinde yapılır; istek yalnız imzalı iade bildirimiyle tamamlanır."
      />

      <form className="admin-toolbar" method="get" action="/package-refunds">
        <div className="admin-toolbar-field">
          <label htmlFor="package-refund-status">Durum</label>
          <select id="package-refund-status" name="status" defaultValue={status ?? ''}>
            <option value="">Tümü</option>
            {PACKAGE_REFUND_STATUSES.map((value) => (
              <option key={value} value={value}>
                {`${PACKAGE_REFUND_STATUS_LABELS[value]} (${response.statusCounts[value] ?? 0})`}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary" data-testid="package-refund-count" data-total={response.total}>
            {response.total} istek
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {status ? (
            <Link className="btn btn-ghost btn-sm" href="/package-refunds">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard title="İstekler">
        {response.items.length === 0 ? (
          <EmptyState
            title="Bu görünümde iade isteği yok"
            description="Hizmet veren destek formundan paket ve kredi iadesi talebi açtığında burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="package-refund-table">
              <thead>
                <tr>
                  <th>Durum</th>
                  <th>Hizmet veren</th>
                  <th>Paket</th>
                  <th>Tutar</th>
                  <th>Başvuru uygunluğu</th>
                  <th>Onay</th>
                  <th>Açılış</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {response.items.map((item) => (
                  <tr key={item.id} data-testid="package-refund-row" data-status={item.status}>
                    <td>
                      <span className={packageRefundStatusBadgeClass(item.status)}>{item.statusLabel}</span>
                    </td>
                    <td>{item.provider.businessName}</td>
                    <td>
                      <div>{item.purchase.packageName}</div>
                      {item.purchase.purchaseNumber ? (
                        <div className="cell-muted" style={{ fontSize: 12 }}>
                          {item.purchase.purchaseNumber}
                        </div>
                      ) : null}
                    </td>
                    <td>{formatPrice(item.purchase.priceAmount, item.purchase.currency)}</td>
                    <td>{PACKAGE_REFUND_RECOMMENDATION_LABELS[item.submittedRecommendation]}</td>
                    <td>
                      {item.approvalKind === 'EXCEPTION' && item.exceptionGround
                        ? `İstisna · ${PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[item.exceptionGround]}`
                        : item.approvalKind === 'NORMAL'
                          ? 'Normal'
                          : <span className="cell-muted">—</span>}
                    </td>
                    <td>
                      <div>{formatDateTime(item.createdAt)}</div>
                      <div className="cell-muted" style={{ fontSize: 12 }}>
                        {item.origin === 'ADMIN' ? 'Yönetici açtı' : 'Hizmet veren açtı'}
                      </div>
                    </td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" href={`/package-refunds/${item.id}`}>
                        Detay
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav className="inline-actions" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          {response.page > 1 ? (
            <Link className="btn btn-secondary btn-sm" href={href(response.page - 1)}>
              ← Önceki
            </Link>
          ) : (
            <span />
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Sayfa {response.page}
          </span>
          {response.hasNextPage ? (
            <Link className="btn btn-secondary btn-sm" href={href(response.page + 1)}>
              Sonraki →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
