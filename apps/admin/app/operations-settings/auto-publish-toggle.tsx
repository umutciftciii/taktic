'use client';

import { useFormStatus } from 'react-dom';
import { toggleAutoPublishAction } from './actions';

/**
 * The marketplace auto-publish switch.
 *
 * The same body as `SchedulerToggle` — a `role="switch"` submit button inside
 * its own form, so it works without JavaScript and reads to a screen reader as
 * the setting's state rather than as an action beside it — with a different
 * action behind it. Kept as its own component rather than a generalised one:
 * the two switches share a shape, not a meaning, and a shared component would
 * need a prop to say which endpoint it posts to.
 *
 * The payload is only the state being asked for, computed here from what is
 * currently true, so a double submission asks for the same thing twice and the
 * API records one change. `useFormStatus` disables the button for the life of
 * the submission.
 */
export function AutoPublishToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleAutoPublishAction} className="scheduler-toggle-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <ToggleSubmit enabled={enabled} />
    </form>
  );
}

function ToggleSubmit({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      role="switch"
      aria-checked={enabled}
      aria-label={`Pazar talepleri otomatik yayınlansın: ${enabled ? 'açık' : 'kapalı'}`}
      className={`scheduler-switch${enabled ? ' is-on' : ''}`}
      disabled={pending}
      aria-disabled={pending}
      data-testid="auto-publish-toggle"
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
