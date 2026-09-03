import { apiFetch, RefundScanResponse, requireAdmin } from '../../lib/api';
import { RefundScanClient } from './refund-scan-client';

type RefundScanPageProps = {
  searchParams?: Promise<{
    limit?: string;
  }>;
};

/**
 * The `olderThanHours` control this screen used to carry is gone, and it is not
 * coming back as the configurable window.
 *
 * The window is a commercial term: a super admin sets it on the operations
 * settings screen, and every offer snapshots the term it was sold under when it
 * is created. A scan control would be neither — it would shorten one run's
 * window and refund offers whose customers still had the time they were
 * promised. The API accepts no such parameter; `limit` is a batch size and
 * changes nothing about who qualifies.
 */
export default async function RefundScanPage({ searchParams }: RefundScanPageProps) {
  await requireAdmin();

  const params = (await searchParams) ?? {};
  const limit = Math.min(readPositiveInt(params.limit, 100), 500);
  const query = new URLSearchParams({ limit: String(limit) });
  const scan = await apiFetch<RefundScanResponse>(`/offers/refund-scan?${query.toString()}`);

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">İade Taraması</h1>
        <p className="page-subtitle">
          İade süresi dolmuş ve hâlâ görüntülenmemiş teklifleri önizleyin ve iadeyi çalıştırın.
          Her teklif kendi iade süresine göre değerlendirilir; görüntülenmiş tekliflerde kredi
          iadesi yapılmaz.
        </p>
      </header>

      <RefundScanClient initialLimit={limit} initialScan={scan} />
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
