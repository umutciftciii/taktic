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
 */
export const NO_RECORDED_RUN = 'kayıtlı çalışma yok';

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
  const outcome =
    run.status === 'FAILED'
      ? `${SCHEDULER_RUN_STATUS_LABELS.FAILED}${run.errorCode ? ` (${run.errorCode})` : ''}`
      : SCHEDULER_RUN_STATUS_LABELS.SUCCESS;
  const summary = options.withSummary && run.summary ? ` · ${run.summary}` : '';
  return `Son çalışma ${formatDateTime(run.finishedAt)} · ${outcome}${summary}`;
}
