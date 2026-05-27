import Link from 'next/link';
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
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Refund Scan</h1>
      <p>Preview and execute admin-triggered refunds for not-viewed offers.</p>
      <RefundScanClient
        initialLimit={limit}
        initialOlderThanHours={olderThanHours}
        initialScan={scan}
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
