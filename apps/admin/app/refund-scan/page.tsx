import { apiFetch, RefundScanResponse, requireAdmin } from '../../lib/api';
import { parsePage } from '../../lib/list-query';
import { scanQuery } from './scan-query';
import { PageHeader } from '../../components/page-header';
import { RefundScanClient } from './refund-scan-client';

type RefundScanPageProps = {
  searchParams?: Promise<{
    limit?: string;
    page?: string;
  }>;
};

/**
 * İade kontrolü (#11), design `refund` (ADMIN-DESIGN-001 Faz 3A).
 *
 * The `olderThanHours` control this screen used to carry is gone, and it is not
 * coming back as the configurable window.
 *
 * The window is a commercial term: a super admin sets it on the operations
 * settings screen, and every offer snapshots the term it was sold under when it
 * is created. A scan control would be neither — it would shorten one run's
 * window and refund offers whose customers still had the time they were
 * promised. The API accepts no such parameter; `limit` is a batch size and
 * changes nothing about who qualifies.
 *
 * API-REFUND-SCAN-PAGINATION-001: the preview is the API's, a page at a time
 * (`?page=`, 50 rows), with the API's `total` and credit sum over every
 * eligible offer — the same predicate as the dashboard's "iade adayı". It used
 * to be the first `limit` offers and their count, which stopped being the
 * whole set at 100. `limit` is now only the run's batch size, as on the API.
 *
 * The design's "Son tarama · 2 saat önce" figure is not drawn: the refund-scan
 * endpoints do not report it. The scheduled job's last run is persisted now
 * (OPS-SCHEDULER-RUN-PERSISTENCE-001) and shown on the operations settings
 * screen, behind its own permission; a hand-run from this screen is not a
 * scheduler run and is not recorded there.
 */

/**
 * The design's ⓘ, corrected on one point: "siz onaylayana kadar hiçbir kredi
 * hareket etmez" holds for this screen, but the same rule also runs on a
 * schedule when the job is switched on in the operations settings.
 */
const SCREEN_INFO =
  'Müşterinin hiç açmadığı ve iade süresi dolan tekliflerde harcanan kredi hizmet verene geri verilir — verdiği teklif hiç görülmediyse karşılığını almamış sayılır. Bu ekran önce uygun teklifleri listeler; buradan başlatılan iade siz onaylamadan çalışmaz. Müşterinin gördüğü teklifler iade edilmez. Otomatik iade işi Operasyon ayarlarında açıksa aynı kural zamanlanmış olarak da çalışır.';

export default async function RefundScanPage({ searchParams }: RefundScanPageProps) {
  const { can } = await requireAdmin('OFFER_REFUND_SCAN_READ');

  const params = (await searchParams) ?? {};
  const limit = Math.min(readPositiveInt(params.limit, 100), 500);
  const page = parsePage(params.page);
  const scan = await apiFetch<RefundScanResponse>(`/offers/refund-scan?${scanQuery(page)}`);

  return (
    <main className="refund-scan-page">
      <PageHeader
        title="İade kontrolü"
        subtitle="İade süresi her teklifin verildiği andaki kurala göre hesaplanır; bu ekrandan süreyi değiştiremezsiniz. Süreyi Operasyon ayarları belirler; görüntülenmiş tekliflerde kredi iadesi yapılmaz."
        info={SCREEN_INFO}
      />

      <RefundScanClient
        initialLimit={limit}
        page={page}
        initialScan={scan}
        canExecute={can('OFFER_REFUND_EXECUTE')}
        canOpenOffers={can('OFFERS_READ')}
        canOpenRequests={can('REQUESTS_READ')}
        canOpenProviders={can('PROVIDERS_READ_DETAIL')}
      />
    </main>
  );
}

function readPositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
