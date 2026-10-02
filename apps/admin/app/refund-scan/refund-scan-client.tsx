'use client';

import { formatDateTime } from '@taktic/shared';
import Link from 'next/link';
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { KeyValueList } from '../../components/key-value-list';
import { SectionCard } from '../../components/section-card';
import { SummaryStrip } from '../../components/summary-strip';
import type { RefundScanExecuteResponse, RefundScanExecuteResult, RefundScanResponse } from '../../lib/api';
import { formatCount } from '../../lib/pagination';
import { Pagination } from '../../components/pagination';
import { executeRefundScanAction, refreshRefundScanAction } from './actions';
import { CONFIRMATION_PROOF_FIELD } from '../../lib/confirmation-proof-keys';

type RefundScanClientProps = {
  initialScan: RefundScanResponse;
  initialLimit: number;
  /** The preview page on screen (`?page=`). */
  page: number;
  /** OFFER_REFUND_EXECUTE, decided on the server; the API refuses regardless. */
  canExecute: boolean;
  /** Read permissions of the screens a row can link to. */
  canOpenOffers: boolean;
  canOpenRequests: boolean;
  canOpenProviders: boolean;
};

const PREVIEW_COLUMNS: DataColumn[] = [
  { key: 'offer', label: 'Teklif' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'request', label: 'Talep' },
  { key: 'credit', label: 'Kredi', align: 'end' },
  { key: 'submittedAt', label: 'Gönderim' },
  { key: 'hours', label: 'Saat', align: 'end' },
  { key: 'window', label: 'İade süresi' },
  { key: 'eligibleAt', label: 'İade zamanı' },
  { key: 'result', label: 'Sonuç' },
];

const RESULT_COLUMNS: DataColumn[] = [
  { key: 'offer', label: 'Teklif' },
  { key: 'status', label: 'Durum' },
  { key: 'reason', label: 'Sebep' },
];

const RESULT_LABELS: Record<RefundScanExecuteResult['status'], string> = {
  REFUNDED: 'İade edildi',
  SKIPPED: 'Atlandı',
  FAILED: 'Başarısız',
};

/**
 * The scan screen's interactive half.
 *
 * Two calls: the preview (`GET /offers/refund-scan?page&pageSize`) and the run
 * (`POST /offers/refund-scan/execute {limit}`), made through this app's server
 * (./actions.ts). The run starts only after a confirmation that says what it
 * will do.
 *
 * API-REFUND-SCAN-PAGINATION-001: the preview no longer depends on the limit.
 * It is one page of every eligible offer, and its `total` and credit sum are
 * the API's over all of them, so the figures on screen are the whole set. The
 * limit is only the run's batch size: the run takes the oldest `limit`
 * candidates — the first rows of page 1 — and the dialog says so with the
 * limit typed now, so there is no stale preview to refresh before running.
 */
export function RefundScanClient({
  initialScan,
  initialLimit,
  page,
  canExecute,
  canOpenOffers,
  canOpenRequests,
  canOpenProviders,
}: RefundScanClientProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [scan, setScan] = useState(initialScan);
  const [executeResult, setExecuteResult] = useState<RefundScanExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const eligible = scan.total;
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= 500;
  /** How many offers a run with this limit would take now: the oldest of the eligible set. */
  const batch = limitValid ? Math.min(limit, eligible) : 0;

  /** Reads this page of the preview again; false (with the message shown) when it was refused. */
  async function loadPreview(): Promise<boolean> {
    const preview = await refreshRefundScanAction(page);
    if (!preview.ok) {
      setError(preview.error);
      return false;
    }
    setScan(preview.data);
    return true;
  }

  function refreshDryRun() {
    startTransition(async () => {
      setError(null);
      setExecuteResult(null);
      await loadPreview();
    });
  }

  function executeScan(event: FormEvent<HTMLFormElement>) {
    // The confirmation submits this form; nothing here posts it as a page.
    event.preventDefault();
    if (!limitValid || eligible === 0) return;
    const runLimit = limit;
    // The dialog's proof rides in the form for this one submission; it is read
    // here, synchronously, and handed to the action.
    const proof = new FormData(event.currentTarget).get(CONFIRMATION_PROOF_FIELD);
    startTransition(async () => {
      setError(null);
      const run = await executeRefundScanAction(runLimit, typeof proof === 'string' ? proof : null);
      if (!run.ok) {
        setError(run.error);
        return;
      }
      setExecuteResult(run.data);
      // The preview after the run, so the screen shows what is left.
      await loadPreview();
    });
  }

  return (
    <>
      <SummaryStrip
        label="Tarama özeti"
        items={[
          {
            label: 'İade edilecek',
            value: `${formatCount(eligible)} teklif`,
            note: 'Tüm uygun adaylar, müşteri hiç görmedi',
            tone: eligible > 0 ? 'success' : 'neutral',
            testId: 'refund-scan-eligible',
          },
          {
            label: 'Geri verilecek kredi',
            value: formatCount(scan.totalCreditCost),
            note: 'Tüm uygun adayların toplamı',
            testId: 'refund-scan-credits',
          },
          {
            label: 'Atlanan',
            value: formatCount(scan.skippedCount),
            note: 'Tüm tekliflerde, nedenleri aşağıda',
          },
          {
            label: 'Yeni tekliflerin iade süresi',
            value: `${scan.currentWindowHours} saat`,
            note: 'Operasyon ayarlarından',
          },
        ]}
      />

      <SectionCard
        title="Tarama sonucu"
        subtitle={
          canExecute
            ? 'Onaylamadan hiçbir kredi hareket etmez.'
            : 'Bu hesap önizlemeyi görebilir; iadeyi çalıştırma yetkisi yok.'
        }
        className="refund-scan-card"
      >
        <div className="refund-scan-controls">
          <label className="detail-form-field">
            <span>Limit</span>
            <input
              max="500"
              min="1"
              name="limit"
              type="number"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              aria-describedby="refund-scan-limit-note"
            />
          </label>
          <button className="btn btn-secondary btn-sm" disabled={isPending} type="button" onClick={refreshDryRun}>
            Yeniden tara
          </button>
          {canExecute ? (
            <form onSubmit={executeScan} data-testid="refund-scan-execute-form">
              <ConfirmDialog
                proof="refund-scan.execute"
                triggerLabel={`${formatCount(batch)} teklifin iadesini onayla`}
                triggerClassName="btn btn-primary btn-sm"
                disabled={isPending || eligible === 0 || !limitValid}
                title={`${formatCount(batch)} teklifin kredisi iade edilsin mi?`}
                consequence={
                  <>
                    <p>
                      Şu anda {formatCount(eligible)} teklif iadeye uygun; hepsinin kredisi toplam{' '}
                      {formatCount(scan.totalCreditCost)}. Bu çalıştırma bunların en eskisinden başlayarak{' '}
                      {formatCount(batch)} tanesini işler
                      {eligible > batch ? `; kalan ${formatCount(eligible - batch)} teklif sonraki çalıştırmaya kalır` : ''}.
                    </p>
                    <p>
                      Onaylarsanız en fazla {formatCount(limit)} aday yeniden sorgulanır ve her teklif o anda
                      yeniden değerlendirilir: arada müşterinin açtığı teklif atlanır, yeni uygun hâle gelen teklif
                      iade edilebilir. Sonuç bu yüzden önizlemeden farklı olabilir; aşağıda teklif teklif gösterilir.
                    </p>
                    <p>
                      İade edilen her teklifin kredisi hizmet verenin bakiyesine eklenir, kredi hareketlerinde
                      görülmeyen teklif iadesi olarak kaydedilir ve hizmet verene kredi iadesi e-postası gider. İade
                      geri alınamaz.
                    </p>
                  </>
                }
                confirmLabel="Evet, iadeyi çalıştır"
                testId="refund-scan-execute"
              />
            </form>
          ) : null}
        </div>
        <p className="detail-muted-note" id="refund-scan-limit-note">
          Limit yalnız bu çalıştırmada işlenecek en eski aday sayısını sınırlar (1–500); kimin iade alacağını ve
          önizlemeyi değiştirmez. Her teklif oluşturulduğu andaki kendi süresine göre değerlendirilir.
        </p>
        {canExecute && !limitValid ? (
          <p className="refund-scan-stale" role="status" data-testid="refund-scan-limit-invalid">
            Limit 1 ile 500 arasında bir tam sayı olmalı.
          </p>
        ) : null}
        {error ? (
          <div className="notice-error" role="alert" data-testid="refund-scan-error">
            {error}
          </div>
        ) : null}
      </SectionCard>

      {executeResult ? (
        <SectionCard
          title="Çalıştırma sonucu"
          subtitle={`İşlendi ${executeResult.processed} · İade ${executeResult.refunded} · Atlandı ${executeResult.skipped}`}
          padded={executeResult.results.length === 0}
        >
          <div data-testid="refund-scan-result">
            {executeResult.results.length === 0 ? (
              <p className="detail-muted-note">Bu çalıştırmada işlenecek teklif çıkmadı.</p>
            ) : (
              <DataTable caption="Çalıştırma sonucu" columns={RESULT_COLUMNS} minWidth={640}>
                {executeResult.results.map((result) => (
                  <tr key={result.offerId}>
                    <td>
                      <RecordId id={result.offerId} href={canOpenOffers ? `/offers/${result.offerId}` : null} />
                    </td>
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
                        {RESULT_LABELS[result.status] ?? result.status}
                      </span>
                    </td>
                    <td className="cell-muted">{result.reason}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Önizleme"
        subtitle="Tüm uygun teklifler, en eski aday başta; çalıştırma bu sırayla işler."
        padded={scan.items.length === 0}
      >
        {scan.items.length === 0 ? (
          scan.total > 0 ? (
            <EmptyState
              title="Bu sayfada aday yok."
              description={`Toplam ${formatCount(scan.total)} uygun teklif var; önceki sayfalara dönün.`}
            />
          ) : (
            <EmptyState
              title="Bu taramada uygun teklif yok."
              description="Müşterinin açmadığı bir teklifin iade süresi dolduğunda burada görünür."
            />
          )
        ) : (
          <DataTable caption="İade önizlemesi" columns={PREVIEW_COLUMNS} minWidth={1100} testId="refund-scan-preview">
            {scan.items.map((item) => (
              <tr key={item.offerId} data-testid="refund-scan-row">
                <td>
                  <RecordId id={item.offerId} href={canOpenOffers ? `/offers/${item.offerId}` : null} />
                </td>
                <td>
                  <RecordId id={item.providerId} href={canOpenProviders ? `/providers/${item.providerId}` : null} />
                </td>
                <td>
                  <RecordId id={item.requestId} href={canOpenRequests ? `/requests/${item.requestId}` : null} />
                </td>
                <td className="is-num">{item.creditCost}</td>
                <td>{formatDateTime(item.submittedAt)}</td>
                <td className="is-num">{item.hoursSinceSubmitted ?? '-'}</td>
                <td>{item.windowHours === null ? '-' : `${item.windowHours} saat`}</td>
                <td>{item.eligibleAt ? formatDateTime(item.eligibleAt) : '-'}</td>
                <td>
                  <div className="cell-stack">
                    <span className="badge badge-good">İade edilecek</span>
                    <span className="cell-muted">{item.reasonCode}</span>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {scan.total > 0 ? (
          <Pagination
            path="/refund-scan"
            params={{ limit: limit === 100 || !limitValid ? '' : String(limit) }}
            page={scan.page}
            pageSize={scan.pageSize}
            total={scan.total}
            hasNextPage={scan.hasNextPage}
            noun="aday"
            summaryTestId="refund-scan-count"
          />
        ) : null}
      </SectionCard>

      <SectionCard title="Neden atlandı" subtitle="Kural dışında kalan teklifler, tüm kayıtlarda.">
        <KeyValueList
          items={[
            { label: 'Zaten iade edildi', value: formatCount(scan.skippedSummary.alreadyRefunded) },
            { label: 'Müşteri görüntüledi', value: formatCount(scan.skippedSummary.viewed) },
            { label: 'Yeterince eski değil', value: formatCount(scan.skippedSummary.notOldEnough) },
            { label: 'Kredi harcaması yok', value: formatCount(scan.skippedSummary.noCreditSpend) },
            { label: 'Müşteri kararı kaydedildi', value: formatCount(scan.skippedSummary.adminDecision) },
            { label: 'Politika dışı', value: formatCount(scan.skippedSummary.outOfPolicy) },
            { label: 'İade zamanı kayıtlı değil', value: formatCount(scan.skippedSummary.noSchedule) },
          ]}
        />
      </SectionCard>
    </>
  );
}

/** A raw id, as a link when this session may open its screen. */
function RecordId({ id, href }: { id: string; href: string | null }): ReactNode {
  const code = <code className="cell-break">{id}</code>;
  return href ? (
    <Link className="cell-link" href={href}>
      {code}
    </Link>
  ) : (
    code
  );
}
