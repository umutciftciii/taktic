import Link from 'next/link';
import { formatDateTime, type CampaignEvaluationQueue } from '../../lib/api';

/**
 * The one sentence every campaign screen carries (CMP-002 S1, S2B2).
 *
 * Read from the database on each render — `engineEnabled` is the
 * OperationsSettings column, fail-closed — so the badge says what is true
 * rather than what this slice assumes. The switch lives on the operations
 * settings screen (CMP-004 S4), behind an explicit confirmation; while it is
 * off, activation and resumption are refused by the API and the screen says
 * so before the operator tries.
 */
export function CampaignEngineNotice({
  engineEnabled,
  queue,
  canOpenOperationsSettings,
}: {
  engineEnabled: boolean;
  queue?: CampaignEvaluationQueue;
  /** OPERATIONS_SETTINGS_READ — without it the screen's name is plain text, not a link to /yetkisiz. */
  canOpenOperationsSettings: boolean;
}) {
  const settingsLink = canOpenOperationsSettings ? (
    <Link href="/operations-settings#kampanya-motoru">Operasyon Ayarları</Link>
  ) : (
    'Operasyon Ayarları'
  );
  if (engineEnabled) {
    return (
      <div className="notice notice-info" role="status" data-testid="campaign-engine-state" data-engine="on">
        <strong>Kampanya motoru açık.</strong> Gerçek olaylar (onay, kanıt, ödeme) bekleyen olay olarak kaydedilir ve
        değerlendirme işçisi tarafından ayrı bir işlemde değerlendirilir; hak ediş promosyon kredisi olarak yazılır. Motor{' '}
        {settingsLink} ekranından kapatılır.
        {queue ? <QueueLine queue={queue} /> : null}
      </div>
    );
  }
  return (
    <div className="notice notice-warning" role="status" data-testid="campaign-engine-state" data-engine="off">
      <strong>Kampanya motoru kapalı — etkinleştirme yapılamaz.</strong> Kampanyalar tanımlanır ve saklanır; hiçbir olay
      kaydedilmez ya da değerlendirilmez, hiçbir hizmet verene kredi verilmez. Etkinleştir ve devam ettir motor açılana kadar
      reddedilir; motor yalnız {settingsLink} ekranından, açık
      onayla açılır.
      {queue && queue.pending + queue.processing + queue.retryWait > 0 ? <QueueLine queue={queue} /> : null}
    </div>
  );
}

/** Read-only: how many raised events wait for the worker, and the last closed error code. */
function QueueLine({ queue }: { queue: CampaignEvaluationQueue }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12.5 }} data-testid="campaign-evaluation-queue">
      Değerlendirme kuyruğu: bekleyen {queue.pending} · işlenen {queue.processing} · yeniden deneme {queue.retryWait}
      {queue.lastErrorCode ? (
        <>
          {' '}
          · son hata kodu <code>{queue.lastErrorCode}</code>
          {queue.lastErrorAt ? ` (${formatDateTime(queue.lastErrorAt)})` : ''}
        </>
      ) : null}
    </div>
  );
}
