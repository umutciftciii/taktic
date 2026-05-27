'use client';

import { useState, useTransition } from 'react';
import type { RefundScanExecuteResponse, RefundScanResponse } from '../../lib/api';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type RefundScanClientProps = {
  initialScan: RefundScanResponse;
  initialOlderThanHours: number;
  initialLimit: number;
};

export function RefundScanClient({
  initialScan,
  initialOlderThanHours,
  initialLimit,
}: RefundScanClientProps) {
  const [olderThanHours, setOlderThanHours] = useState(initialOlderThanHours);
  const [limit, setLimit] = useState(initialLimit);
  const [scan, setScan] = useState(initialScan);
  const [executeResult, setExecuteResult] = useState<RefundScanExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function refreshDryRun() {
    startTransition(async () => {
      setError(null);
      setExecuteResult(null);
      try {
        const params = new URLSearchParams({
          olderThanHours: String(olderThanHours),
          limit: String(limit),
        });
        const response = await fetch(`${apiUrl}/offers/refund-scan?${params.toString()}`, {
          credentials: 'include',
        });
        setScan(await readApiResponse<RefundScanResponse>(response));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Dry-run failed');
      }
    });
  }

  function executeScan() {
    startTransition(async () => {
      setError(null);
      try {
        const response = await fetch(`${apiUrl}/offers/refund-scan/execute`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ olderThanHours, limit }),
        });
        const result = await readApiResponse<RefundScanExecuteResponse>(response);
        setExecuteResult(result);
        refreshDryRun();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Execute failed');
      }
    });
  }

  return (
    <>
      <section>
        <h2>Scan controls</h2>
        <label>
          Older than hours
          <input
            min="1"
            name="olderThanHours"
            type="number"
            value={olderThanHours}
            onChange={(event) => setOlderThanHours(Number(event.target.value))}
          />
        </label>
        <label>
          Limit
          <input
            max="500"
            min="1"
            name="limit"
            type="number"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
        <p>
          <button disabled={isPending} type="button" onClick={refreshDryRun}>
            Refresh dry-run
          </button>{' '}
          <button disabled={isPending || scan.eligibleCount === 0} type="button" onClick={executeScan}>
            Execute scan
          </button>
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </section>

      <section>
        <h2>Dry-run result</h2>
        <p>
          Eligible: {scan.eligibleCount} | Skipped: {scan.skippedCount}
        </p>
        <ul>
          <li>Already refunded: {scan.skippedSummary.alreadyRefunded}</li>
          <li>Viewed: {scan.skippedSummary.viewed}</li>
          <li>Not old enough: {scan.skippedSummary.notOldEnough}</li>
          <li>No credit spend: {scan.skippedSummary.noCreditSpend}</li>
          <li>Status not eligible: {scan.skippedSummary.statusNotEligible}</li>
        </ul>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Offer</th>
              <th>Provider</th>
              <th>Request</th>
              <th>Credit</th>
              <th>Submitted</th>
              <th>Hours</th>
              <th>Policy</th>
            </tr>
          </thead>
          <tbody>
            {scan.items.map((item) => (
              <tr key={item.offerId}>
                <td>{item.offerId}</td>
                <td>{item.providerId}</td>
                <td>{item.requestId}</td>
                <td>{item.creditCost}</td>
                <td>{formatDate(item.submittedAt)}</td>
                <td>{item.hoursSinceSubmitted ?? '-'}</td>
                <td>
                  {item.recommendedAction}/{item.reasonCode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {scan.items.length === 0 ? <p>No eligible offers in this dry-run.</p> : null}
      </section>

      {executeResult ? (
        <section>
          <h2>Execute result</h2>
          <p>
            Processed: {executeResult.processed} | Refunded: {executeResult.refunded} | Skipped:{' '}
            {executeResult.skipped}
          </p>
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Offer</th>
                <th>Status</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {executeResult.results.map((result) => (
                <tr key={result.offerId}>
                  <td>{result.offerId}</td>
                  <td>{result.status}</td>
                  <td>{result.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

async function readApiResponse<T>(response: Response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `API request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
