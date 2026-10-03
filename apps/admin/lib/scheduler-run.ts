import type { SchedulerRunRecord } from './api';

/**
 * One job's last recorded run, in words — the operations screen and the
 * dashboard's "Sistem şu anda ne yapıyor" say it the same way
 * (OPS-SCHEDULER-RUN-PERSISTENCE-001).
 *
 * Only what the run row says. A RUNNING row has no end: it is either in
 * progress or its process stopped before recording one, and the text says
 * exactly that rather than guessing which. No row is "no recorded run" —
 * runs before the history was kept are unknown, not "never".
 *
 * ADMIN-BACKEND-TRUTH-002: a run whose process stopped is no longer RUNNING
 * forever — once its lease runs out the API closes it FAILED with
 * `PROCESS_INTERRUPTED`, and that reads "yarıda kaldı", not "hata verdi": the
 * job did not fail, its process went away. A RUNNING row is therefore a run
 * whose lease is still being renewed, or one not yet past it — so its text
 * still says "sürüyor ya da yarıda kaldı" until the recovery has spoken.
 */
export const NO_RECORDED_RUN = 'kayıtlı çalışma yok';

/** The API's code for a run its recovery closed after the lease ran out. */
export const PROCESS_INTERRUPTED = 'PROCESS_INTERRUPTED';

export const SCHEDULER_RUN_STATUS_LABELS: Record<SchedulerRunRecord['status'], string> = {
  SUCCESS: 'tamamlandı',
  FAILED: 'hata verdi',
  RUNNING: 'bitişi kaydedilmedi',
};

export function describeSchedulerRun(
  run: SchedulerRunRecord | null,
  formatDateTime: (value: string) => string,
  options: { withSummary?: boolean } = {},
): string {
  if (!run) return NO_RECORDED_RUN;
  if (run.status === 'RUNNING' || run.finishedAt === null) {
    return `Son çalışma ${formatDateTime(run.startedAt)} başladı · bitişi kaydedilmedi (sürüyor ya da yarıda kaldı)`;
  }
  if (run.status === 'FAILED' && run.errorCode === PROCESS_INTERRUPTED) {
    // The end the process never wrote: say when it started and when it was
    // declared over, not a finish time it did not have.
    return `Son çalışma ${formatDateTime(run.startedAt)} başladı · yarıda kaldı (süreç durdu; ${formatDateTime(run.finishedAt)} itibarıyla kapatıldı)`;
  }
  const outcome =
    run.status === 'FAILED'
      ? `${SCHEDULER_RUN_STATUS_LABELS.FAILED}${run.errorCode ? ` (${run.errorCode})` : ''}`
      : SCHEDULER_RUN_STATUS_LABELS.SUCCESS;
  const summary = options.withSummary && run.summary ? ` · ${run.summary}` : '';
  return `Son çalışma ${formatDateTime(run.finishedAt)} · ${outcome}${summary}`;
}

/**
 * The refund scan's last hand-run, in words: the same outcome text with who
 * ran it (ADMIN-BACKEND-TRUTH-002). `null` → "elle çalıştırma kaydı yok".
 */
export function describeManualRun(
  run: SchedulerRunRecord | null,
  formatDateTime: (value: string) => string,
): string {
  if (!run) return 'Elle çalıştırma kaydı yok';
  const who = run.actor?.name ? ` · ${run.actor.name}` : '';
  return `Elle: ${describeSchedulerRun(run, formatDateTime, { withSummary: true }).replace(/^Son çalışma /, '')}${who}`;
}
