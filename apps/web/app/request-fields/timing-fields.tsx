/**
 * When the customer wants the work done.
 *
 * The one list, for both request forms: the values are what the API's
 * `urgency` column has always carried from the marketplace form, and the vitrin
 * card's form posts the same three so a lead's timing reads like any other
 * request's on the provider's screen. Not a free-text field anywhere — "bu
 * hafta içinde" typed by hand and "THIS_WEEK" chosen from a list are not the
 * same fact to anything that sorts or filters by it.
 */
export const URGENCY_OPTIONS = [
  { value: 'TODAY', label: 'Bugün' },
  { value: 'THIS_WEEK', label: 'Bu hafta' },
  { value: 'FLEXIBLE', label: 'Esnek' },
] as const;

export type UrgencyValue = (typeof URGENCY_OPTIONS)[number]['value'];

type UrgencySelectProps = {
  label?: string;
  required?: boolean;
  helpText?: string | null;
  testId?: string;
  /** A saved draft's urgency, when one is being restored. */
  defaultValue?: string;
};

export function UrgencySelect({
  label = 'Aciliyet',
  required = false,
  helpText,
  testId = 'request-urgency',
  defaultValue,
}: UrgencySelectProps) {
  return (
    <label className="form-row">
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      <select name="urgency" defaultValue={defaultValue ?? ''} required={required} data-testid={testId}>
        <option value="">Seçiniz</option>
        {URGENCY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helpText ? <span className="help-text">{helpText}</span> : null}
    </label>
  );
}
