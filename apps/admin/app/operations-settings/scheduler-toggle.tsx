'use client';

import { useFormStatus } from 'react-dom';
import { toggleSchedulerAction } from './actions';

/**
 * One job's switch.
 *
 * A real `role="switch"` rather than a styled checkbox: it is a submit button
 * inside its own form, so it works without JavaScript, and the role plus
 * `aria-checked` is what tells a screen reader that this control *is* the
 * job's state rather than an action that happens to sit next to it. The
 * accessible name carries the job's own name, so "kapalı, Paket yenileme" is
 * unambiguous with four of these on the page.
 *
 * The whole payload is the job key and the state being asked for — the state is
 * computed here from what is currently true, so a double submission asks for
 * the same thing twice and the API records one change, not two.
 *
 * `useFormStatus` disables the button for the life of the submission, which is
 * the visible half of the double-submit guard; the invisible half is the API's
 * own "a write that changes nothing writes nothing".
 */
export function SchedulerToggle({
  job,
  jobName,
  enabled,
}: {
  job: string;
  jobName: string;
  enabled: boolean;
}) {
  return (
    <form action={toggleSchedulerAction} className="scheduler-toggle-form">
      <input type="hidden" name="job" value={job} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <ToggleSubmit job={job} jobName={jobName} enabled={enabled} />
    </form>
  );
}

function ToggleSubmit({
  job,
  jobName,
  enabled,
}: {
  job: string;
  jobName: string;
  enabled: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      role="switch"
      aria-checked={enabled}
      aria-label={`${jobName}: ${enabled ? 'açık' : 'kapalı'}`}
      className={`scheduler-switch${enabled ? ' is-on' : ''}`}
      disabled={pending}
      aria-disabled={pending}
      data-testid={`scheduler-toggle-${job}`}
    >
      <span className="scheduler-switch-track" aria-hidden="true">
        <span className="scheduler-switch-thumb" />
      </span>
      <span className="scheduler-switch-label">
        {pending ? 'Kaydediliyor…' : enabled ? 'Açık' : 'Kapalı'}
      </span>
    </button>
  );
}
