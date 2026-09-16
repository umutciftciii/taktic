'use client';

import { useEffect, useRef, useState } from 'react';
import { minorToLiraDraft, parseLiraToMinor } from '../../../lib/lira-input';
import { LiraInput } from '../../request-fields/lira-input';

type BudgetFieldsProps = {
  /** The minimum field's label, when a bound BUDGET question renames it. */
  minLabel: string;
  /** Whether the category's bound BUDGET question makes a budget mandatory. */
  required: boolean;
  /** Category-specific wording under the minimum field, when there is any. */
  minHelpText?: string | null;
  /** Told when a value changed, so the form can refresh its own signals. */
  onChange?: () => void;
  /** A saved draft's minimum budget, in kuruş, when one is being restored. */
  defaultMin?: number | null;
  /** A saved draft's maximum budget, in kuruş, when one is being restored. */
  defaultMax?: number | null;
};

/**
 * The smallest budget the API accepts, in kuruş — one whole lira.
 *
 * Mirrors `@Min(100)` on CreateServiceRequestDto and the same bound in
 * `normalizeOptionalPriceMinor`. Saying it here turns a 400 into a message
 * beside the field the customer is still standing in; the API remains the rule.
 */
const MIN_BUDGET_MINOR = 100;

/**
 * Minimum and maximum budget, written the way lira are written in Turkey.
 *
 * The pair is one component because one of its rules spans both fields: a
 * minimum above the maximum is not a range, and the customer should hear that
 * from the field rather than from a rejected submission. The API enforces it
 * too — this endpoint is public — so nothing here is the rule, only where the
 * rule is first heard.
 *
 * The inputs are text rather than `type="number"`, because a number input
 * refuses to hold `5.000,00` at all: browsers parse its value with a fixed
 * locale, so the grouped Turkish form reads back as empty. Text plus
 * `inputMode="decimal"` keeps the numeric keypad on a phone, and the
 * constraints the number input used to carry — required, and at least one
 * lira — are restated through the browser's own validity API, so
 * `checkValidity()` and `reportValidity()` behave for these two fields exactly
 * as they do for every other control in the step.
 */
export function BudgetFields({
  minLabel,
  required,
  minHelpText,
  onChange,
  defaultMin = null,
  defaultMax = null,
}: BudgetFieldsProps) {
  const [min, setMin] = useState(() => minorToLiraDraft(defaultMin));
  const [max, setMax] = useState(() => minorToLiraDraft(defaultMax));
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);

  /*
   * The two rules the browser used to carry in `min="1"` and would otherwise
   * lose with the number input, plus the one that spans both fields. Re-run
   * whenever either value changes, and cleared as soon as it holds again — a
   * custom validity that is never cleared makes a form permanently
   * unsubmittable.
   */
  useEffect(() => {
    const minMinor = parseLiraToMinor(min);
    const maxMinor = parseLiraToMinor(max);

    const belowOneLira = 'En az 1,00 TL girin.';
    minRef.current?.setCustomValidity(
      minMinor !== null && minMinor < MIN_BUDGET_MINOR ? belowOneLira : '',
    );

    if (maxMinor !== null && maxMinor < MIN_BUDGET_MINOR) {
      maxRef.current?.setCustomValidity(belowOneLira);
    } else if (minMinor !== null && maxMinor !== null && minMinor > maxMinor) {
      maxRef.current?.setCustomValidity(
        'Maksimum bütçe, minimum bütçeden küçük olamaz.',
      );
    } else {
      maxRef.current?.setCustomValidity('');
    }
  }, [min, max]);

  return (
    <>
      <label className="form-row">
        <span>
          {minLabel}
          {required ? ' *' : ''}
        </span>
        <LiraInput
          ref={minRef}
          name="budgetMin"
          value={min}
          onValueChange={setMin}
          onChange={onChange}
          required={required}
          testId="request-budget-min"
          placeholder="Örn. 1.500,00"
        />
        <span className="help-text">
          {minHelpText ??
            (required ? 'Bu hizmet için bütçe aralığı gerekiyor.' : 'İsteğe bağlı.')}
        </span>
      </label>
      <label className="form-row">
        <span>Maksimum bütçe</span>
        <LiraInput
          ref={maxRef}
          name="budgetMax"
          value={max}
          onValueChange={setMax}
          onChange={onChange}
          testId="request-budget-max"
          placeholder="Örn. 3.000,00"
        />
        <span className="help-text">İsteğe bağlı.</span>
      </label>
    </>
  );
}
