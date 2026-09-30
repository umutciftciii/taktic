'use client';

import { useFormStatus } from 'react-dom';
import { Toggle } from '../../components/toggle';
import { toggleAutoPublishAction } from './actions';

/**
 * The marketplace auto-publish switch.
 *
 * A `role="switch"` submit button inside its own form, so it works without
 * JavaScript and reads to a screen reader as the setting's state rather than
 * as an action beside it. Kept as its own component rather than a generalised
 * one: the switches share a shape, not a meaning, and a shared component would
 * need a prop to say which endpoint it posts to.
 *
 * The payload is only the state being asked for, computed here from what is
 * currently true, so a double submission asks for the same thing twice and the
 * API records one change. `useFormStatus` disables the switch for the life of
 * the submission.
 *
 * ADMIN-DESIGN-001 Faz 3E: drawn with the design's `Toggle`; still one tap —
 * it changes only what happens to the *next* request, in both directions.
 */
export function AutoPublishToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleAutoPublishAction} className="setting-toggle-form">
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
      label="Pazar talepleri otomatik yayınlansın"
      stateText={pending ? { on: 'Kaydediliyor…', off: 'Kaydediliyor…' } : undefined}
      disabled={pending}
      testId="auto-publish-toggle"
    />
  );
}
