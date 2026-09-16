'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { completeLiraAmount, formatLiraDraft } from '../../lib/lira-input';

/**
 * One Turkish-lira amount field, shared by every form that asks for money:
 * the request's budget pair and the provider's offer price. Grouped as it is
 * typed, completed to `4.500,00` when it is left, and read back through
 * `parseLiraToMinor` by whoever posts it — see `lib/lira-input.ts` for the
 * rules and why no floating point is involved.
 */
export type LiraInputProps = {
  ref: RefObject<HTMLInputElement | null>;
  name: string;
  value: string;
  onValueChange: (next: string) => void;
  onChange?: () => void;
  required?: boolean;
  testId: string;
  placeholder: string;
  id?: string;
  className?: string;
  'aria-describedby'?: string;
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
export function LiraInput({
  ref,
  name,
  value,
  onValueChange,
  onChange,
  required = false,
  testId,
  placeholder,
  id,
  className,
  'aria-describedby': describedBy,
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
      id={id}
      className={className}
      aria-describedby={describedBy}
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
