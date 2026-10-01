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
import { executeRefundScanAction, refreshRefundScanAction } from './actions';
import { CONFIRMATION_PROOF_FIELD } from '../../lib/confirmation-proof-keys';

type RefundScanClientProps = {
  initialScan: RefundScanResponse;
  initialLimit: number;
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
 * Two calls, both the endpoints they always were: the preview
 * (`GET /offers/refund-scan?limit`) and the run
 * (`POST /offers/refund-scan/execute {limit}`), made through this app's server
 * (./actions.ts). What this adds is the step the design asks for in between —
 * the run starts only after a confirmation that says what it will do — and one
 * rule that keeps that confirmation honest: the run always uses the limit the
 * preview on screen was made with. Change the limit and the run stays closed
 * until the preview is refreshed, so the number in the dialog is never about a
 * different batch.
 */
export function RefundScanClient({
  initialScan,
  initialLimit,
  canExecute,
  canOpenOffers,
  canOpenRequests,
  canOpenProviders,
}: RefundScanClientProps) {
  const [limit, setLimit] = useState(initialLimit);
  const [scannedLimit, setScannedLimit] = useState(initialLimit);
  const [scan, setScan] = useState(initialScan);
  const [executeResult, setExecuteResult] = useState<RefundScanExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const previewCredits = scan.items.reduce((total, item) => total + item.creditCost, 0);
  const limitChanged = limit !== scannedLimit;
  const eligible = scan.eligibleCount;

  /** Reads the preview for `nextLimit`; false (with the message shown) when it was refused. */
  async function loadPreview(nextLimit: number): Promise<boolean> {
    const preview = await refreshRefundScanAction(nextLimit);
    if (!preview.ok) {
      setError(preview.error);
      return false;
    }
    setScan(preview.data);
    setScannedLimit(nextLimit);
    return true;
  }

  function refreshDryRun() {
    startTransition(async () => {
      setError(null);
      setExecuteResult(null);
      await loadPreview(limit);
    });
  }

  function executeScan(event: FormEvent<HTMLFormElement>) {
    // The confirmation submits this form; nothing here posts it as a page.
    event.preventDefault();
    if (limitChanged || eligible === 0) return;
    const runLimit = scannedLimit;
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
      await loadPreview(runLimit);
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
            note: `İlk ${formatCount(scannedLimit)} aday içinde, müşteri hiç görmedi`,
            tone: eligible > 0 ? 'success' : 'neutral',
            testId: 'refund-scan-eligible',
          },
          {
            label: 'Geri verilecek kredi',
            value: formatCount(previewCredits),
            note: 'Önizlemedeki tekliflerin toplamı',
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
                triggerLabel={`${formatCount(eligible)} teklifin iadesini onayla`}
                triggerClassName="btn btn-primary btn-sm"
                disabled={isPending || eligible === 0 || limitChanged}
                title={`${formatCount(eligible)} teklifin kredisi iade edilsin mi?`}
                consequence={
                  <>
                    <p>
                      Önizlemede {formatCount(eligible)} teklif için toplam {formatCount(previewCredits)} kredi iade
                      edilecek görünüyor.
                    </p>
                    <p>
                      Onaylarsanız en fazla {formatCount(scannedLimit)} aday yeniden sorgulanır ve her teklif o anda
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
          Limit yalnız bu çalıştırmada işlenecek en eski aday sayısını sınırlar (1–500); kimin iade alacağını
          değiştirmez. Her teklif oluşturulduğu andaki kendi süresine göre değerlendirilir.
        </p>
        {canExecute && limitChanged ? (
          <p className="refund-scan-stale" role="status" data-testid="refund-scan-stale">
            Limit değişti. İadeyi onaylamadan önce “Yeniden tara” ile önizlemeyi güncelleyin.
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
        subtitle={`${formatCount(scan.items.length)} teklif · en eski aday başta`}
        padded={scan.items.length === 0}
      >
        {scan.items.length === 0 ? (
          <EmptyState
            title="Bu taramada uygun teklif yok."
            description="Müşterinin açmadığı bir teklifin iade süresi dolduğunda burada görünür."
          />
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
