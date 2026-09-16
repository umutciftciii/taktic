'use client';

import { useEffect, useRef, useState } from 'react';
import { compareIsoDays, endOfWeekIsoDay, isIsoDay, todayIsoDay } from '@taktic/shared';
import type { Question } from '../../lib/api';

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

type DateRange = { start: string; end: string };

/**
 * The range an urgency stands for, on the Istanbul calendar of `today`.
 *
 * `TODAY` is one day; `THIS_WEEK` runs from today to the Sunday that closes
 * the week (a Sunday is its own week's end); `FLEXIBLE` names no dates. This
 * is the browser's copy of the rule the API enforces in
 * `normalizePreferredDateRange`: what is filled in here is what the server
 * will accept, and a customer who edits it past the rule is told by the API.
 */
export function defaultRangeFor(urgency: string, today: string): DateRange | null {
  switch (urgency) {
    case 'TODAY':
      return { start: today, end: today };
    case 'THIS_WEEK':
      return { start: today, end: endOfWeekIsoDay(today) };
    default:
      return null;
  }
}

/** The custom-validity sentence for a pair of inputs, or '' when they hold. */
export function rangeValidity(start: string, end: string): { start: string; end: string } {
  if ((start && !end) || (!start && end)) {
    const message = 'Tarih aralığının iki ucunu da girin.';
    return { start: start ? '' : message, end: end ? '' : message };
  }
  if (start && end && isIsoDay(start) && isIsoDay(end) && compareIsoDays(start, end) > 0) {
    return { start: '', end: 'Bitiş tarihi başlangıçtan önce olamaz.' };
  }
  return { start: '', end: '' };
}

type TimingFieldsProps = {
  /** The category's PREFERRED_DATE-bound question, when it has one: it renames the range and can require it. */
  dateQuestion?: Question | null;
  urgencyLabel?: string;
  urgencyHelpText?: string | null;
  urgencyTestId?: string;
  /** A saved draft's values, when one is being restored. */
  defaultUrgency?: string;
  defaultStart?: string;
  defaultEnd?: string;
  /** Told after any of the three values changed, so the form can refresh its own signals. */
  onChange?: () => void;
};

/**
 * Urgency plus the date range it stands for, as one control group.
 *
 * Choosing an urgency fills the two dates in — today, or today to Sunday — so
 * the customer sees what the choice means and can adjust it. The dates are
 * ordinary `<input type="date">`s posting `YYYY-MM-DD`: no Date object is ever
 * built from them here, so the browser's zone cannot move the day. "Today" is
 * read once, through the product's zone, at the moment the choice is made.
 *
 * A native `<select>` fires no change when the selected option is chosen
 * again, so the defaults can be re-applied with the button beside it — which
 * is also the keyboard's way of doing it.
 */
export function TimingFields({
  dateQuestion,
  urgencyLabel = 'Aciliyet',
  urgencyHelpText,
  urgencyTestId = 'request-urgency',
  defaultUrgency,
  defaultStart,
  defaultEnd,
  onChange,
}: TimingFieldsProps) {
  const [urgency, setUrgency] = useState(defaultUrgency ?? '');
  const [start, setStart] = useState(defaultStart ?? '');
  const [end, setEnd] = useState(defaultEnd ?? '');
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  // `min` is read on the client so it is the customer's Istanbul today, not
  // the day the server rendered the page on.
  const [today, setToday] = useState('');
  useEffect(() => {
    setToday(todayIsoDay());
  }, []);

  useEffect(() => {
    const validity = rangeValidity(start, end);
    startRef.current?.setCustomValidity(validity.start);
    endRef.current?.setCustomValidity(validity.end);
  }, [start, end]);

  function applyDefaults(nextUrgency: string) {
    const range = defaultRangeFor(nextUrgency, todayIsoDay());
    if (range) {
      setStart(range.start);
      setEnd(range.end);
    }
  }

  const hasDefaults = defaultRangeFor(urgency, today || '2000-01-01') !== null;
  const required = dateQuestion?.isRequired ?? false;
  const rangeLabel = dateQuestion?.label ?? 'Tercih edilen tarih aralığı';

  return (
    <>
      <div className="form-row">
        <label className="form-row" style={{ marginBottom: 0 }}>
          <span>{urgencyLabel}</span>
          <select
            name="urgency"
            value={urgency}
            data-testid={urgencyTestId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setUrgency(next);
              applyDefaults(next);
              onChange?.();
            }}
          >
            <option value="">Seçiniz</option>
            {URGENCY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {hasDefaults ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm timing-reapply"
            onClick={() => {
              applyDefaults(urgency);
              onChange?.();
            }}
            data-testid="request-timing-reapply"
          >
            Varsayılan aralığı uygula
          </button>
        ) : null}
        <span className="help-text">
          {urgencyHelpText ??
            (urgency === 'FLEXIBLE'
              ? 'Esnek: tarih vermezseniz zamanlama hizmet verenle kararlaştırılır; isterseniz yine de bir aralık girebilirsiniz.'
              : 'Bugün veya Bu hafta seçildiğinde tarihler otomatik dolar; dilerseniz değiştirebilirsiniz.')}
        </span>
      </div>

      <fieldset className="form-row timing-range" data-testid="request-date-range">
        <legend>
          {rangeLabel}
          {required ? ' *' : ''}
        </legend>
        <div className="timing-range-inputs">
          <label className="form-row" style={{ marginBottom: 0 }}>
            <span>Başlangıç</span>
            <input
              ref={startRef}
              name="preferredDate"
              type="date"
              min={today || undefined}
              required={required}
              value={start}
              onChange={(event) => {
                setStart(event.currentTarget.value);
                onChange?.();
              }}
              data-testid="request-preferred-date"
            />
          </label>
          <label className="form-row" style={{ marginBottom: 0 }}>
            <span>Bitiş</span>
            <input
              ref={endRef}
              name="preferredDateEnd"
              type="date"
              min={start || today || undefined}
              required={required}
              value={end}
              onChange={(event) => {
                setEnd(event.currentTarget.value);
                onChange?.();
              }}
              data-testid="request-preferred-date-end"
            />
          </label>
        </div>
        {dateQuestion?.helpText ? <span className="help-text">{dateQuestion.helpText}</span> : null}
      </fieldset>
    </>
  );
}
