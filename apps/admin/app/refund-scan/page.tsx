import { apiFetch, RefundScanResponse, requireAdmin } from '../../lib/api';
import { RefundScanClient } from './refund-scan-client';

type RefundScanPageProps = {
  searchParams?: Promise<{
    limit?: string;
  }>;
};

/**
 * The `olderThanHours` control this screen used to carry is gone.
 *
 * The window is the product promise — 48 hours — and a screen that can shorten
 * it is a screen that can refund an offer the customer still had time to open.
 * The API no longer accepts the parameter either; `limit` is a batch size and
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
          {scan.windowHours} saat içinde görüntülenmemiş teklifleri önizleyin ve iadeyi
          çalıştırın. Görüntülenmiş tekliflerde kredi iadesi yapılmaz.
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
