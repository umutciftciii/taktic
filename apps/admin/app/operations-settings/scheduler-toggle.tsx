'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { Toggle } from '../../components/toggle';
import { toggleSchedulerAction } from './actions';

/**
 * One job's switch.
 *
 * A real `role="switch"` rather than a styled checkbox: it is a submit button
 * inside its own form, so it works without JavaScript, and the role plus
 * `aria-checked` is what tells a screen reader that this control *is* the
 * job's state rather than an action that happens to sit next to it. The
 * accessible name is the job's own name, so it is unambiguous with six of
 * these on the page.
 *
 * The whole payload is the job key and the state being asked for — the state is
 * computed here from what is currently true, so a double submission asks for
 * the same thing twice and the API records one change, not two.
 *
 * ADMIN-DESIGN-001 Faz 3E: switching a job *on* asks first (ConfirmDialog, the
 * same switch as its trigger): the dialog says what the job will start doing
 * at its next cron run, and — for the two money jobs — the money or credit it
 * moves. The form, its two fields and SCHEDULERS_WRITE are unchanged.
 *
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A: switching *off* asks too, but
 * only for the two jobs whose silence costs somebody — package renewal (no
 * renewal charge, no period end) and the unviewed-offer refund (earned
 * refunds wait) — with proof `scheduler.disable`. The other jobs only stop
 * their next run and stay one tap.
 */
export function SchedulerToggle({
  job,
  jobName,
  enabled,
  consequence,
  disableConsequence,
}: {
  job: string;
  jobName: string;
  enabled: boolean;
  /** What switching the job on starts doing; shown in the dialog. */
  consequence: ReactNode;
  /**
   * What switching the job off holds back — given only for the two jobs whose
   * stopping delays money or credit (`SCHEDULER_DISABLE_CONFIRMATION`). The
   * others switch off in one tap.
   */
  disableConsequence?: ReactNode;
}) {
  return (
    <form action={toggleSchedulerAction} className="setting-toggle-form">
      <input type="hidden" name="job" value={job} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? (
        disableConsequence ? (
          <ConfirmDialog
            proof="scheduler.disable"
            triggerLabel={jobName}
            triggerClassName="toggle"
            switchChecked
            tone="primary"
            title={`“${jobName}” kapatılsın mı?`}
            consequence={disableConsequence}
            confirmLabel="Evet, işi kapat"
            testId={`scheduler-toggle-${job}`}
          />
        ) : (
          <OffSwitch job={job} jobName={jobName} />
        )
      ) : (
        <ConfirmDialog
          proof="scheduler.toggle"
          triggerLabel={jobName}
          triggerClassName="toggle"
          switchChecked={false}
          tone="primary"
          title={`“${jobName}” açılsın mı?`}
          consequence={consequence}
          confirmLabel="Evet, işi aç"
          testId={`scheduler-toggle-${job}`}
        />
      )}
    </form>
  );
}

function OffSwitch({ job, jobName }: { job: string; jobName: string }) {
  const { pending } = useFormStatus();
  return (
    <Toggle
      type="submit"
      checked
      label={jobName}
      stateText={pending ? { on: 'Kaydediliyor…', off: 'Kaydediliyor…' } : undefined}
      disabled={pending}
      testId={`scheduler-toggle-${job}`}
    />
  );
}
