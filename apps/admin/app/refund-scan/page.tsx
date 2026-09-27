import { apiFetch, RefundScanResponse, requireAdmin } from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { RefundScanClient } from './refund-scan-client';

type RefundScanPageProps = {
  searchParams?: Promise<{
    limit?: string;
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
 * The design's "Son tarama · 2 saat önce" figure is not drawn: the refund-scan
 * endpoints do not report it, and the scheduler's last run lives in one API
 * process's memory only.
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
  const query = new URLSearchParams({ limit: String(limit) });
  const scan = await apiFetch<RefundScanResponse>(`/offers/refund-scan?${query.toString()}`);

  return (
    <main className="refund-scan-page">
      <PageHeader
        title="İade kontrolü"
        subtitle="İade süresi her teklifin verildiği andaki kurala göre hesaplanır; bu ekrandan süreyi değiştiremezsiniz. Süreyi Operasyon ayarları belirler; görüntülenmiş tekliflerde kredi iadesi yapılmaz."
        info={SCREEN_INFO}
      />

      <RefundScanClient
        initialLimit={limit}
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
