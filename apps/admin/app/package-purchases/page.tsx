import Link from 'next/link';
import {
  AdminPaymentConfig,
  apiFetch,
  formatDateTime,
  formatPrice,
  PackagePurchase,
  PackagePurchasePage,
  PackagePurchaseStatus,
  PackagePurchaseSummary,
  PURCHASE_CREDIT_HOLD_LABELS,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { KeyValueList } from '../../components/key-value-list';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SectionCard } from '../../components/section-card';

/**
 * Every package purchase — credit packages and vitrin packages — newest first.
 *
 * ADMIN-DESIGN-001 Faz 3D (paket 2 `29-paket-satislari`, prototip
 * `list:purchases`): the design's list template, with everything the screen
 * already carried kept in place:
 *
 * - The payment provider card, behind its own read (PAYMENTS_CONFIG_READ). A
 *   role that may read purchases but not the provider setup gets the list
 *   without it, not /yetkisiz for the whole screen (F3).
 * - API-HARDENING-001: the open credit hold count — counted over every
 *   purchase whatever the filter, so money taken but not yet delivered as
 *   credit is never hidden by the view — its "Yalnız bunları göster" link,
 *   and the hold badge on the row.
 * - The manual review notice and a badge on the row it counts.
 * - The `status`, `providerId`, `packageId`, `showcasePackageId` and
 *   `creditHold` query filters; the first and the last have fields, the ids
 *   stay as a pin.
 *
 * ADMIN-BACKEND-TRUTH-002: the list is paged on the server — one page of 25
 * and the filtered set's `total`, from the same predicate — so the screen no
 * longer reads every purchase. The figures that used to be counted over the
 * whole fetched list (paid, manual review, open credit holds) are the
 * database's counts over the same filters (`/package-purchases/summary`, and a
 * one-row page of `creditHold=OPEN` for its `total`). A filter change starts
 * again from page 1: the filter form does not carry `page`.
 *
 * Not rendered: the design's Ara and Tarih filters (the API takes neither),
 * "Bu ay 96 satış · 184.300 ₺" (that total is the finance summary's, behind
 * FINANCE_READ) and "Excel'e aktar" (no export exists).
 */

const PATH = '/package-purchases';

const PAGE_SIZE = 25;

const PURCHASE_STATUSES: PackagePurchaseStatus[] = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'];

/** The design's ⓘ, corrected: a refund does not take credit back on its own. */
const SCREEN_INFO =
  'Hizmet verenlerin satın aldığı kredi ve vitrin paketleri. "Bekliyor" durumundaki bir satışta ödeme henüz onaylanmamıştır; krediler yalnız imzası doğrulanmış ödeme bildirimi gelince yüklenir. Ödeme sağlayıcısından gelen iade ya da ters ibraz bildirimi krediyi kendiliğinden düşmez: satış manuel incelemeye işaretlenir.';

const COLUMNS: DataColumn[] = [
  { key: 'purchase', label: 'Satın alma' },
  { key: 'provider', label: 'İşletme' },
  { key: 'package', label: 'Paket' },
  { key: 'credits', label: 'Kredi', align: 'end' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'status', label: 'Ödeme' },
  { key: 'reference', label: 'Ödeme referansı' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

type AdminPackagePurchasesPageProps = {
  searchParams?: Promise<{
    status?: PackagePurchaseStatus;
    providerId?: string;
    packageId?: string;
    showcasePackageId?: string;
    creditHold?: string;
    page?: string;
  }>;
};

export default async function AdminPackagePurchasesPage({ searchParams }: AdminPackagePurchasesPageProps) {
  const { can } = await requireAdmin('PACKAGE_PURCHASES_READ');
  // The payment provider card is its own read (PAYMENTS_CONFIG_READ). A role
  // that may see purchases but not the provider setup gets the list without
  // the card, not a redirect to /yetkisiz for the whole screen.
  const canReadPaymentConfig = can('PAYMENTS_CONFIG_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const params = (await searchParams) ?? {};
  const status = params.status && PURCHASE_STATUSES.includes(params.status) ? params.status : '';
  const providerId = (params.providerId ?? '').trim();
  const packageId = (params.packageId ?? '').trim();
  const showcasePackageId = (params.showcasePackageId ?? '').trim();
  const holdFilter = params.creditHold === 'OPEN' || params.creditHold === 'ANY' ? params.creditHold : null;
  const page = parsePage(params.page);

  const filterQuery = new URLSearchParams();
  if (status) filterQuery.set('status', status);
  if (providerId) filterQuery.set('providerId', providerId);
  if (packageId) filterQuery.set('packageId', packageId);
  if (showcasePackageId) filterQuery.set('showcasePackageId', showcasePackageId);
  if (holdFilter) filterQuery.set('creditHold', holdFilter);
  const pageQuery = new URLSearchParams(filterQuery);
  pageQuery.set('page', String(page));
  pageQuery.set('pageSize', String(PAGE_SIZE));
  const summaryQuery = filterQuery.toString();

  const [response, totals, paymentConfig, openHolds] = await Promise.all([
    apiFetch<PackagePurchasePage>(`/package-purchases?${pageQuery.toString()}`),
    apiFetch<PackagePurchaseSummary>(`/package-purchases/summary${summaryQuery ? `?${summaryQuery}` : ''}`),
    canReadPaymentConfig ? apiFetch<AdminPaymentConfig>('/payments/config') : Promise.resolve(null),
    // API-HARDENING-001: counted over every purchase, whatever the filter, so
    // captured-but-undelivered money is never hidden by the view. One row is
    // enough: only its `total` is read.
    apiFetch<PackagePurchasePage>('/package-purchases?creditHold=OPEN&page=1&pageSize=1'),
  ]);
  const purchases = response.items;

  const manualReviewCount = totals.manualReview;
  const hasFilters = Boolean(status || providerId || packageId || showcasePackageId || holdFilter);
  const filterParams: QueryParams = {
    status,
    providerId,
    packageId,
    showcasePackageId,
    creditHold: holdFilter ?? '',
  };
  const paidCount = totals.byStatus.PAID ?? 0;

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Bu filtreyle satın alma yok'
        : 'Henüz paket satın alınmadı'
      : `${formatCount(response.total)} satın alma · ${formatCount(paidCount)} tanesi ödendi · en yeni başta`;

  return (
    <main className="finance-list-page">
      <PageHeader title="Paket satışları" subtitle={summary} info={SCREEN_INFO} />

      {openHolds.total > 0 ? (
        <div className="notice notice-warning detail-notice" data-testid="credit-hold-notice">
          <strong>{formatCount(openHolds.total)}</strong> satın almada ödeme sağlayıcıda tahsil edildi ama kredi,
          hizmet verenin bakiyesi üst sınırı aşacağı için teslim edilmedi. Otomatik iade yapılmaz; her birini
          detayında inceleyin.{' '}
          {holdFilter === 'OPEN' ? null : (
            <Link href="/package-purchases?creditHold=OPEN" data-testid="credit-hold-filter">
              Yalnız bunları göster
            </Link>
          )}
        </div>
      ) : null}

      {manualReviewCount > 0 ? (
        <div className="notice notice-warning detail-notice" data-testid="manual-review-notice">
          <strong>{formatCount(manualReviewCount)}</strong> satın alma için sağlayıcıdan iade/ters ibraz bildirimi
          geldi ve manuel inceleme bekliyor. Bu bildirimler otomatik olarak kredi düşmez.
        </div>
      ) : null}

      {providerId || packageId || showcasePackageId ? (
        <div className="notice detail-notice" data-testid="purchase-pin">
          {providerId ? (
            <>
              Yalnız bir işletmenin satın almaları (<code className="cell-break">{providerId}</code>).{' '}
            </>
          ) : null}
          {packageId ? (
            <>
              Yalnız bir paketin satın almaları (<code className="cell-break">{packageId}</code>).{' '}
            </>
          ) : null}
          {showcasePackageId ? (
            <>
              Yalnız bir vitrin paketinin satın almaları (<code className="cell-break">{showcasePackageId}</code>).{' '}
            </>
          ) : null}
          <Link
            href={buildHref(PATH, filterParams, {
              providerId: undefined,
              packageId: undefined,
              showcasePackageId: undefined,
            })}
          >
            Bu sabitlemeyi kaldır
          </Link>
        </div>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        preserve={{ providerId, packageId, showcasePackageId }}
        label="Paket satışı filtreleri"
        testId="purchase-filters"
      >
        <FilterField label="Ödeme durumu" htmlFor="purchase-status">
          <select id="purchase-status" name="status" defaultValue={status}>
            <option value="">Tümü</option>
            {PURCHASE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Kredi teslimi" htmlFor="purchase-credit-hold-filter">
          <select id="purchase-credit-hold-filter" name="creditHold" defaultValue={holdFilter ?? ''}>
            <option value="">Tümü</option>
            <option value="OPEN">Tahsil edildi, kredi teslim edilmedi</option>
            <option value="ANY">Teslim vakası olan (açık ya da kapanmış)</option>
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {purchases.length === 0 ? (
          response.total > 0 ? (
            // A page past the last row, reached by editing the URL.
            <EmptyState
              title="Bu sayfada satın alma yok."
              description="Liste bu sayfaya kadar uzanmıyor."
              action={
                <Link className="btn btn-secondary btn-sm" href={buildHref(PATH, filterParams)}>
                  İlk sayfaya dön
                </Link>
              }
            />
          ) : (
            <EmptyState
              title={hasFilters ? 'Bu filtreyle satın alma bulunamadı.' : 'Henüz paket talebi yok.'}
              description={
                hasFilters
                  ? 'Filtreleri temizleyerek tüm satın almaları görebilirsiniz.'
                  : 'Hizmet verenler paket aldıkça burada görünür.'
              }
              action={
                hasFilters ? (
                  <Link className="btn btn-secondary btn-sm" href={PATH}>
                    Filtreyi temizle
                  </Link>
                ) : null
              }
            />
          )
        ) : (
          <DataTable caption="Paket satışları" columns={COLUMNS} minWidth={1120} testId="purchase-table">
            {purchases.map((purchase) => (
              <PurchaseRow key={purchase.id} purchase={purchase} canOpenProvider={canOpenProvider} />
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
            noun="satın alma"
            summaryTestId="purchase-count"
          />
        ) : null}
      </div>

      {/* The payment setup, under the list it explains: the list is what this screen is for. */}
      {paymentConfig ? (
        <SectionCard
          title="Ödeme sağlayıcı"
          subtitle="Bu kurulum yalnızca test modunda çalışır ve gerçek tahsilat yapmaz."
          className="payment-provider-card"
        >
          <div data-testid="payment-provider-config">
            <p className="detail-muted-note">
              Canlı ödeme bu sürümde açılamaz: Lemon Squeezy&apos;nin bu pazar yeri için uygunluk onayı yazılı olarak
              alınmadan canlı moda geçilmeyecektir. Canlı moda işaret eden bir ortam değişkeni ayarlanırsa API
              açılışta durur.
            </p>
            <KeyValueList
              items={[
                {
                  label: 'Sağlayıcı',
                  value: (
                    <>
                      <code>{paymentConfig.provider}</code>{' '}
                      {paymentConfig.provider === 'lemon-squeezy-test'
                        ? '(Lemon Squeezy sandbox)'
                        : '(uygulama içi mock ödeme)'}
                    </>
                  ),
                },
                { label: 'Mod', value: <span className="badge badge-warn">test</span> },
                { label: 'Canlı tahsilat', value: 'Kapalı — bu sürümde açılamaz' },
                {
                  label: 'Yapılandırma',
                  value: paymentConfig.ready ? (
                    'Tamamlandı'
                  ) : (
                    <>
                      Eksik ayar var:{' '}
                      {paymentConfig.missingConfig.map((key) => (
                        <code key={key} className="config-key">
                          {key}
                        </code>
                      ))}
                      <span className="detail-muted-note config-key-note">
                        Yalnızca değişken adları gösterilir; API anahtarı ve webhook gizli anahtarı hiçbir ekranda ve
                        hiçbir API yanıtında görünmez.
                      </span>
                    </>
                  ),
                },
                {
                  label: 'Kredi yükleme',
                  value:
                    'Yalnızca imzası doğrulanmış ödeme bildirimi (webhook) sonrasında. Ödeme sayfasından dönüş, tarayıcı sonucu veya istemci isteği kredi yükleyemez.',
                },
              ]}
            />
          </div>
        </SectionCard>
      ) : null}
    </main>
  );
}

function PurchaseRow({ purchase, canOpenProvider }: { purchase: PackagePurchase; canOpenProvider: boolean }) {
  const purchaseRef = purchase.purchaseNumber ?? `#${purchase.id.slice(-8)}`;
  const detailHref = `/package-purchases/${purchase.id}`;
  return (
    <tr data-testid="purchase-row" data-status={purchase.status}>
      <td>
        <div className="cell-stack">
          <code className="display-number cell-break">{purchaseRef}</code>
          <span className="cell-muted cell-nowrap">{formatDateTime(purchase.createdAt)}</span>
        </div>
      </td>
      <td>
        <strong className="cell-break">{purchase.provider.businessName}</strong>
      </td>
      <td>
        <span className="cell-break">{purchase.packageNameSnapshot}</span>
      </td>
      <td className="is-num">{formatCount(purchase.creditAmountSnapshot)}</td>
      <td className="is-num cell-nowrap">
        <strong>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</strong>
      </td>
      <td>
        <div className="cell-stack purchase-status-cell">
          <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
          {purchase.creditHold ? (
            <span
              className={purchase.creditHold.status === 'OPEN' ? 'badge badge-warn' : 'badge badge-muted'}
              data-testid="purchase-credit-hold"
            >
              {PURCHASE_CREDIT_HOLD_LABELS[purchase.creditHold.status]}
            </span>
          ) : null}
          {purchase.manualReviewAt ? (
            <span className="badge badge-bad" data-testid="purchase-manual-review">
              Manuel inceleme
            </span>
          ) : null}
        </div>
      </td>
      <td className="cell-muted cell-break">{purchase.mockPaymentReference ?? '—'}</td>
      <td className="col-actions">
        <div className="inline-actions">
          <Link className="btn btn-secondary btn-sm" href={detailHref} aria-label={`Aç: ${purchaseRef}`}>
            Aç
          </Link>
          {canOpenProvider ? (
            <Link
              className="btn btn-ghost btn-sm"
              href={`/providers/${purchase.providerId}`}
              aria-label={`İşletmeyi aç: ${purchase.provider.businessName}`}
            >
              İşletme
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
