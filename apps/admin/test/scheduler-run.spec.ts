import { describe, expect, it } from 'vitest';
import type { SchedulerRunRecord } from '../lib/api';
import { describeManualRun, describeSchedulerRun, NO_RECORDED_RUN, PROCESS_INTERRUPTED } from '../lib/scheduler-run';

const T = (value: string) => `T(${value})`;

function run(overrides: Partial<SchedulerRunRecord>): SchedulerRunRecord {
  return {
    id: 'run-1',
    status: 'SUCCESS',
    trigger: 'SCHEDULER',
    startedAt: '2026-10-03T06:00:00.000Z',
    finishedAt: '2026-10-03T06:00:05.000Z',
    summary: 'processed=2 refunded=1 skipped=1 failed=0',
    errorCode: null,
    ...overrides,
  };
}

describe('scheduler run wording (ADMIN-BACKEND-TRUTH-002)', () => {
  it('says a recovered run was interrupted, with its start and when it was closed — not "hata verdi"', () => {
    const text = describeSchedulerRun(
      run({ status: 'FAILED', errorCode: PROCESS_INTERRUPTED, summary: null, finishedAt: '2026-10-03T06:07:00.000Z' }),
      T,
      { withSummary: true },
    );
    expect(text).toBe(
      'Son çalışma T(2026-10-03T06:00:00.000Z) başladı · yarıda kaldı (süreç durdu; T(2026-10-03T06:07:00.000Z) itibarıyla kapatıldı)',
    );
    expect(text).not.toContain('hata verdi');
  });

  it('keeps a real failure a failure', () => {
    expect(describeSchedulerRun(run({ status: 'FAILED', errorCode: 'TypeError', summary: null }), T)).toBe(
      'Son çalışma T(2026-10-03T06:00:05.000Z) · hata verdi (TypeError)',
    );
  });

  it('keeps "no recorded run" and the open-run wording', () => {
    expect(describeSchedulerRun(null, T)).toBe(NO_RECORDED_RUN);
    expect(describeSchedulerRun(run({ status: 'RUNNING', finishedAt: null, summary: null }), T)).toBe(
      'Son çalışma T(2026-10-03T06:00:00.000Z) başladı · bitişi kaydedilmedi (sürüyor ya da yarıda kaldı)',
    );
  });

  it('names the operator of a hand-run, and says when there is none', () => {
    expect(describeManualRun(run({ trigger: 'MANUAL', actor: { id: 'u1', name: 'Ayşe Yönetici' } }), T)).toBe(
      'Elle: T(2026-10-03T06:00:05.000Z) · tamamlandı · processed=2 refunded=1 skipped=1 failed=0 · Ayşe Yönetici',
    );
    expect(describeManualRun(null, T)).toBe('Elle çalıştırma kaydı yok');
  });
});
