'use client';

import { useFormStatus } from 'react-dom';
import { Toggle } from '../../components/toggle';
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
 *
 * ADMIN-DESIGN-001 Faz 3E: drawn with the design's `Toggle`; still one tap —
 * turning it off hides reviews without deleting them, and on shows them again.
 */
export function ProviderReviewsToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleProviderReviewsAction} className="setting-toggle-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <ToggleSubmit enabled={enabled} />
    </form>
  );
}

function ToggleSubmit({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Toggle
      type="submit"
      checked={enabled}
      label="Hizmet veren değerlendirmeleri"
      stateText={pending ? { on: 'Kaydediliyor…', off: 'Kaydediliyor…' } : undefined}
      disabled={pending}
      testId="provider-reviews-toggle"
    />
  );
}
