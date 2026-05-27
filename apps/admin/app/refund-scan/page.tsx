import { apiFetch, RefundScanResponse, requireAdmin } from '../../lib/api';
import { RefundScanClient } from './refund-scan-client';

type RefundScanPageProps = {
  searchParams?: Promise<{
    olderThanHours?: string;
    limit?: string;
  }>;
};

export default async function RefundScanPage({ searchParams }: RefundScanPageProps) {
  await requireAdmin();

  const params = (await searchParams) ?? {};
  const olderThanHours = readPositiveInt(params.olderThanHours, 48);
  const limit = Math.min(readPositiveInt(params.limit, 100), 500);
  const query = new URLSearchParams({
    olderThanHours: String(olderThanHours),
    limit: String(limit),
  });
  const scan = await apiFetch<RefundScanResponse>(`/offers/refund-scan?${query.toString()}`);

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">İade Taraması</h1>
        <p className="page-subtitle">
          Görüntülenmemiş ve yeterince eski teklifler için yönetici tarafından tetiklenen iadeleri önizleyin
          ve çalıştırın.
        </p>
      </header>

      <RefundScanClient initialLimit={limit} initialOlderThanHours={olderThanHours} initialScan={scan} />
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
