'use client';

import { useFormStatus } from 'react-dom';
import { toggleProviderReviewsAction } from './actions';

/**
 * The provider-review switch.
 *
 * The same body as `AutoPublishToggle` — a `role="switch"` submit button
 * inside its own form, so it works without JavaScript and reads to a screen
 * reader as the setting's state rather than as an action beside it — with a
 * different action behind it. Its own component for the reason that one is:
 * the switches share a shape, not a meaning.
 *
 * The payload is only the state being asked for, computed here from what is
 * currently true, so a double submission asks for the same thing twice and
 * the API records one change.
 */
export function ProviderReviewsToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleProviderReviewsAction} className="scheduler-toggle-form">
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
      aria-label={`Hizmet veren değerlendirmeleri: ${enabled ? 'açık' : 'kapalı'}`}
      className={`scheduler-switch${enabled ? ' is-on' : ''}`}
      disabled={pending}
      aria-disabled={pending}
      data-testid="provider-reviews-toggle"
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
