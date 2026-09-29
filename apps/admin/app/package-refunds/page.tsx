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
import { parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';

type PageProps = { searchParams: Promise<{ status?: string; page?: string }> };

const PATH = '/package-refunds';
const PAGE_SIZE = 25;

/** What this queue is, and the one thing it never does. */
const SCREEN_INFO =
  'Hizmet verenlerin destek talebiyle açtığı paket ödeme iadesi istekleri. Bir istek işleme alınır, onaylanır ya da reddedilir; para iadesi ödeme sağlayıcısının panelinde yapılır ve istek yalnız imzalı iade bildirimi gelince tamamlanır. Buradan "iade tamamlandı" işaretlenemez.';

const COLUMNS: DataColumn[] = [
  { key: 'status', label: 'Durum' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'package', label: 'Paket' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'eligibility', label: 'Başvuru uygunluğu' },
  { key: 'approval', label: 'Onay' },
  { key: 'opened', label: 'Açılış' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

/**
 * CMP-006 PR-B — the package refund queue.
 *
 * What a row carries is what the API's allowlist projection carries: the
 * provider's business name, the purchase summary, the status and how the
 * request was opened. No client address, user agent, terms text or digest, and
 * no payment reference — those never leave the API on this surface.
 *
 * ADMIN-DESIGN-001 Faz 3D: the design has no screen for this queue (it is not
 * in the prototype's menu), so it takes the shared list template. The old
 * status select became saved views with the API's own per-status counts —
 * the same `?status=` values, one link each — and the rows, the columns and
 * the page size of 25 are unchanged. Nothing on this screen writes.
 */
export default async function PackageRefundsPage({ searchParams }: PageProps) {
  await requireAdmin('PACKAGE_REFUND_READ');
  const params = await searchParams;
  const status = PACKAGE_REFUND_STATUSES.includes(params.status as PackageRefundRequestStatus)
    ? (params.status as PackageRefundRequestStatus)
    : null;
  const page = parsePage(params.page);

  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status) query.set('status', status);
  const response = await apiFetch<PackageRefundListResponse>(`/admin/package-refund-requests?${query.toString()}`);

  const allCount = PACKAGE_REFUND_STATUSES.reduce((total, value) => total + (response.statusCounts[value] ?? 0), 0);
  const waitingCount = (response.statusCounts.SUBMITTED ?? 0) + (response.statusCounts.UNDER_REVIEW ?? 0);
  const filterParams: QueryParams = { status: status ?? '' };

  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: allCount, testId: 'package-refund-view-all' },
    ...PACKAGE_REFUND_STATUSES.map((value) => ({
      key: value,
      label: PACKAGE_REFUND_STATUS_LABELS[value],
      count: response.statusCounts[value] ?? 0,
      testId: `package-refund-view-${value.toLowerCase()}`,
    })),
  ];

  const summary =
    allCount === 0
      ? 'Henüz paket iadesi isteği yok'
      : waitingCount === 0
        ? `${formatCount(allCount)} istek · karar bekleyen yok`
        : `${formatCount(waitingCount)} istek karar bekliyor · toplam ${formatCount(allCount)}`;

  return (
    <main className="finance-list-page">
      <PageHeader title="Paket iadeleri" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="İade görünümleri"
        items={views}
        active={status ?? ''}
        path={PATH}
        params={filterParams}
        param="status"
        testId="package-refund-views"
      />

      <div className="data-list-card">
        <span className="sr-only" data-testid="package-refund-count" data-total={response.total}>
          {response.total} istek
        </span>
        {response.items.length === 0 ? (
          <EmptyState
            title={
              status
                ? 'Bu görünümde iade isteği yok'
                : response.total > 0
                  ? 'Bu sayfada iade isteği yok'
                  : 'Henüz paket iadesi isteği yok'
            }
            description="Hizmet veren destek formundan paket ve kredi iadesi talebi açtığında burada görünür."
            action={
              status || response.total > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  {status ? 'Tüm istekler' : 'İlk sayfaya dön'}
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Paket iadesi istekleri" columns={COLUMNS} minWidth={1060} testId="package-refund-table">
            {response.items.map((item) => (
              <tr key={item.id} data-testid="package-refund-row" data-status={item.status}>
                <td>
                  <span className={packageRefundStatusBadgeClass(item.status)}>{item.statusLabel}</span>
                </td>
                <td>
                  <strong className="cell-break">{item.provider.businessName}</strong>
                </td>
                <td>
                  <div className="cell-stack">
                    <span className="cell-break">{item.purchase.packageName}</span>
                    {item.purchase.purchaseNumber ? (
                      <code className="cell-muted cell-break">{item.purchase.purchaseNumber}</code>
                    ) : null}
                  </div>
                </td>
                <td className="is-num cell-nowrap">
                  <strong>{formatPrice(item.purchase.priceAmount, item.purchase.currency)}</strong>
                </td>
                <td>{PACKAGE_REFUND_RECOMMENDATION_LABELS[item.submittedRecommendation]}</td>
                <td>
                  {item.approvalKind === 'EXCEPTION' && item.exceptionGround ? (
                    `İstisna · ${PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[item.exceptionGround]}`
                  ) : item.approvalKind === 'NORMAL' ? (
                    'Normal'
                  ) : (
                    <span className="cell-muted">—</span>
                  )}
                </td>
                <td>
                  <div className="cell-stack">
                    <span className="cell-nowrap">{formatDateTime(item.createdAt)}</span>
                    <span className="cell-muted">{item.origin === 'ADMIN' ? 'Yönetici açtı' : 'Hizmet veren açtı'}</span>
                  </div>
                </td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`/package-refunds/${item.id}`}
                    aria-label={`Aç: ${item.provider.businessName} · ${item.purchase.packageName}`}
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="istek"
            summaryTestId="package-refund-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}
