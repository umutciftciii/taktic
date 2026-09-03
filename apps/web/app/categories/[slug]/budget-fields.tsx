'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  completeLiraAmount,
  formatLiraDraft,
  parseLiraToMinor,
} from '../../../lib/lira-input';

type BudgetFieldsProps = {
  /** The minimum field's label, when a bound BUDGET question renames it. */
  minLabel: string;
  /** Whether the category's bound BUDGET question makes a budget mandatory. */
  required: boolean;
  /** Category-specific wording under the minimum field, when there is any. */
  minHelpText?: string | null;
  /** Told when a value changed, so the form can refresh its own signals. */
  onChange?: () => void;
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
}: BudgetFieldsProps) {
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
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

type LiraInputProps = {
  ref: RefObject<HTMLInputElement | null>;
  name: string;
  value: string;
  onValueChange: (next: string) => void;
  onChange?: () => void;
  required?: boolean;
  testId: string;
  placeholder: string;
};

/**
 * One amount field: grouped as it is typed, completed when it is left.
 *
 * Rewriting the value under the customer's hands is what makes the caret the
 * hard part — inserting a grouping dot in front of the caret would otherwise
 * push the next keystroke a character to the left, and every third digit typed
 * would land in the wrong place. So the caret is not restored by position but
 * by content: the digits and comma standing before it are counted in what the
 * customer produced, and the caret is put back after that many of them in the
 * formatted result. Deleting, pasting mid-number and typing in the middle all
 * come out where the customer expects, because none of them change what that
 * count means.
 */
function LiraInput({
  ref,
  name,
  value,
  onValueChange,
  onChange,
  required = false,
  testId,
  placeholder,
}: LiraInputProps) {
  /*
   * Where the caret has to end up once React has written the formatted value
   * back into the field. Null between edits, so a re-render caused by anything
   * else — the other field's state changing, a step being switched — never
   * moves a caret the customer is holding somewhere.
   */
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const position = pendingCaret.current;
    pendingCaret.current = null;
    if (position === null) return;

    const field = ref.current;
    if (field && field === document.activeElement) {
      field.setSelectionRange(position, position);
    }
  });

  return (
    <input
      ref={ref}
      name={name}
      type="text"
      // The numeric keypad with a decimal separator on a phone. `numeric` would
      // offer digits alone and leave no way to type kuruş at all.
      inputMode="decimal"
      autoComplete="off"
      value={value}
      required={required}
      data-testid={testId}
      placeholder={placeholder}
      onChange={(event) => {
        const field = event.currentTarget;
        const typed = field.value;
        const caret = field.selectionStart ?? typed.length;
        const formatted = formatLiraDraft(typed);
        const position = caretAfterSignificant(formatted, significantBefore(typed, caret));

        if (formatted === value) {
          // Nothing changed as far as React is concerned — a `₺`, a second
          // comma, a letter — so no re-render is coming to put the field back.
          // The character the format rejected is removed here instead, which is
          // what stops it from sitting in the DOM under a state that says it is
          // not there.
          field.value = formatted;
          field.setSelectionRange(position, position);
          return;
        }

        pendingCaret.current = position;
        onValueChange(formatted);
        onChange?.();
      }}
      onBlur={(event) => {
        const completed = completeLiraAmount(event.currentTarget.value);
        if (completed !== value) {
          onValueChange(completed);
          onChange?.();
        }
      }}
    />
  );
}

/** Digits and commas — everything grouping does not invent — carry position. */
const SIGNIFICANT = /[\d,]/;

/** How many significant characters stand before the caret in what was typed. */
function significantBefore(value: string, caret: number): number {
  let count = 0;
  for (let index = 0; index < caret && index < value.length; index += 1) {
    if (SIGNIFICANT.test(value[index]!)) {
      count += 1;
    }
  }
  return count;
}

/** Where the caret goes to stand after that many significant characters. */
function caretAfterSignificant(formatted: string, significant: number): number {
  if (significant <= 0) {
    return 0;
  }

  let count = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (SIGNIFICANT.test(formatted[index]!)) {
      count += 1;
      if (count === significant) {
        return index + 1;
      }
    }
  }
  return formatted.length;
}
