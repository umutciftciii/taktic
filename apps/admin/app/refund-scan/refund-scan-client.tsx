'use client';

import { formatDateTime } from '@taktic/shared';
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
        setError(err instanceof Error ? err.message : 'Dry-run başarısız');
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
        setError(err instanceof Error ? err.message : 'Çalıştırma başarısız');
      }
    });
  }

  return (
    <>
      <section className="filters-card">
        <h2 style={{ margin: 0, fontSize: 15 }}>Tarama parametreleri</h2>
        <div className="filters-grid">
          <label className="form-row">
            <span>Saatten eski</span>
            <input
              min="1"
              name="olderThanHours"
              type="number"
              value={olderThanHours}
              onChange={(event) => setOlderThanHours(Number(event.target.value))}
            />
          </label>
          <label className="form-row">
            <span>Limit</span>
            <input
              max="500"
              min="1"
              name="limit"
              type="number"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="inline-actions">
          <button className="btn btn-secondary btn-sm" disabled={isPending} type="button" onClick={refreshDryRun}>
            Dry-run yenile
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={isPending || scan.eligibleCount === 0}
            type="button"
            onClick={executeScan}
          >
            Taramayı çalıştır
          </button>
        </div>
        {error ? <div className="notice-error" role="alert">{error}</div> : null}
      </section>

      <section style={{ marginTop: 18 }}>
        <div className="stat-grid">
          <div className="stat-card">
            <span className="muted">Uygun</span>
            <span className="metric">{scan.eligibleCount}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Atlanan</span>
            <span className="metric">{scan.skippedCount}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Zaten iade</span>
            <span className="metric">{scan.skippedSummary.alreadyRefunded}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Görüntülenmiş</span>
            <span className="metric">{scan.skippedSummary.viewed}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Yeterince eski değil</span>
            <span className="metric">{scan.skippedSummary.notOldEnough}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Kredi harcaması yok</span>
            <span className="metric">{scan.skippedSummary.noCreditSpend}</span>
          </div>
          <div className="stat-card">
            <span className="muted">Durum uygun değil</span>
            <span className="metric">{scan.skippedSummary.statusNotEligible}</span>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 18 }}>
        <div className="table-card">
          <div className="table-header">
            <h2>Dry-run sonuçları</h2>
            <span className="muted" style={{ fontSize: 13 }}>{scan.items.length} kayıt</span>
          </div>
          {scan.items.length === 0 ? (
            <div style={{ padding: 18 }} className="empty-state">Bu taramada uygun teklif yok.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Teklif</th>
                    <th>Hizmet Veren</th>
                    <th>Talep</th>
                    <th>Kredi</th>
                    <th>Gönderim</th>
                    <th>Saat</th>
                    <th>Politika</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.items.map((item) => (
                    <tr key={item.offerId}>
                      <td><code style={{ fontSize: 12 }}>{item.offerId}</code></td>
                      <td><code style={{ fontSize: 12 }}>{item.providerId}</code></td>
                      <td><code style={{ fontSize: 12 }}>{item.requestId}</code></td>
                      <td>{item.creditCost}</td>
                      <td>{formatDate(item.submittedAt)}</td>
                      <td>{item.hoursSinceSubmitted ?? '-'}</td>
                      <td>
                        <span className="badge badge-good">{item.recommendedAction}</span>{' '}
                        <span className="muted" style={{ fontSize: 12 }}>{item.reasonCode}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {executeResult ? (
        <section style={{ marginTop: 18 }}>
          <div className="table-card">
            <div className="table-header">
              <h2>Çalıştırma sonucu</h2>
              <span className="muted" style={{ fontSize: 13 }}>
                İşlendi {executeResult.processed} · İade {executeResult.refunded} · Atlandı{' '}
                {executeResult.skipped}
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Teklif</th>
                    <th>Durum</th>
                    <th>Sebep</th>
                  </tr>
                </thead>
                <tbody>
                  {executeResult.results.map((result) => (
                    <tr key={result.offerId}>
                      <td><code style={{ fontSize: 12 }}>{result.offerId}</code></td>
                      <td>
                        <span
                          className={
                            result.status === 'REFUNDED'
                              ? 'badge badge-good'
                              : result.status === 'FAILED'
                                ? 'badge badge-bad'
                                : 'badge badge-muted'
                          }
                        >
                          {result.status}
                        </span>
                      </td>
                      <td className="muted">{result.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

async function readApiResponse<T>(response: Response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `API isteği ${response.status} ile başarısız`);
  }

  return response.json() as Promise<T>;
}

// Was `dateStyle`/`timeStyle` with no zone, so this client component rendered
// the scan window in the visitor's zone while the server had picked it in UTC.
const formatDate = formatDateTime;
