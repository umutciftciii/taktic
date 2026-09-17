import { NEXT_STEPS_TITLE, nextStepsNoteText } from '../../../lib/request-next-steps';

type NextStepsNoteProps = {
  /**
   * The instant-publish switch as the page read it. Absent means off: the
   * review sentence is the one shown whenever the page could not say
   * otherwise.
   */
  autoPublishEnabled?: boolean;
};

/**
 * The "Sırada ne var?" note in the request form's rail.
 *
 * Only the marketplace form renders this; the vitrin lead form describes a
 * different flow and has no such note. `data-auto-publish` is for the E2E
 * suite, which flips the switch and reads which sentence a fresh page shows.
 */
export function NextStepsNote({ autoPublishEnabled = false }: NextStepsNoteProps) {
  return (
    <div
      className="rail-note"
      style={{ marginTop: 24 }}
      data-testid="request-next-steps"
      data-auto-publish={autoPublishEnabled ? 'on' : 'off'}
    >
      <strong>{NEXT_STEPS_TITLE}</strong> {nextStepsNoteText(autoPublishEnabled)}
    </div>
  );
}
