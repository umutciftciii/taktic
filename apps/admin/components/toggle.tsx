import type { MouseEventHandler } from 'react';

type ToggleProps = {
  checked: boolean;
  /**
   * The switch's name — what it turns on, not its state ("Gelen talepler
   * kendiliğinden yayına girsin"). A screen reader adds "açık/kapalı" from
   * `aria-checked` itself.
   */
  label: string;
  /** The words drawn beside the track; `false` for a bare track. */
  stateText?: { on: string; off: string } | false;
  /** `submit` inside a server-action form (works without JavaScript). */
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  testId?: string;
};

/**
 * The design's 52×28 switch, as a visual layer only.
 *
 * It is a real `<button role="switch" aria-checked>` — the same construction
 * the operations-settings toggles already use, so any of them can adopt this
 * look without changing how it submits. The visible "Açık/Kapalı" text is
 * hidden from assistive technology, because `aria-checked` already announces
 * the state and the accessible name stays the switch's own label.
 */
export function Toggle({
  checked,
  label,
  stateText = { on: 'Açık', off: 'Kapalı' },
  type = 'button',
  name,
  value,
  disabled,
  onClick,
  testId,
}: ToggleProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      name={name}
      value={value}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      {stateText ? (
        <span className="toggle-state" aria-hidden="true">
          {checked ? stateText.on : stateText.off}
        </span>
      ) : null}
    </button>
  );
}
