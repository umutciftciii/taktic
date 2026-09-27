import Link from 'next/link';
import type { ReactNode } from 'react';
import type { QueryParams } from '../lib/list-query';

type FilterBarProps = {
  /** The list's own path; the form GETs back to it. */
  action: string;
  children: ReactNode;
  /** Where "Temizle" goes. Omitted (or null) when there is nothing to clear. */
  clearHref?: string | null;
  /**
   * Query values the form has no field for but must not lose — a saved view
   * or a tab. Page is never carried: a new filter starts on page 1.
   */
  preserve?: QueryParams;
  label?: string;
  testId?: string;
};

/**
 * The list filter row: labelled fields, then "Filtrele" and "Temizle".
 *
 * A plain GET form to the list's own URL, so the filters are the query
 * string — the same parameter names the screen already reads, a shareable
 * address and no client state. It is a `search` landmark, and every field has
 * a real `<label for>`.
 *
 * The fields are uncontrolled (`defaultValue`), so the screen must give the
 * bar a `key` derived from the current filters: a saved-view tab, a pager link
 * or "Temizle" is a client-side navigation, and without a new key React keeps
 * the old inputs and they go on showing the previous filter.
 */
export function FilterBar({
  action,
  children,
  clearHref,
  preserve = {},
  label = 'Filtreler',
  testId,
}: FilterBarProps) {
  return (
    <form className="filter-bar" method="get" action={action} role="search" aria-label={label} data-testid={testId}>
      {Object.entries(preserve).map(([name, value]) =>
        value === undefined || value === null || value === '' ? null : (
          <input key={name} type="hidden" name={name} value={String(value)} />
        ),
      )}
      {children}
      <div className="filter-bar-actions">
        <button className="btn btn-ink btn-sm" type="submit">
          Filtrele
        </button>
        {clearHref ? (
          <Link className="btn btn-link btn-sm" href={clearHref}>
            Temizle
          </Link>
        ) : null}
      </div>
    </form>
  );
}

/**
 * One labelled field of a `FilterBar`. `info` puts an ⓘ beside the label —
 * outside the `<label>`, so the button is not part of the field's name.
 */
export function FilterField({
  label,
  htmlFor,
  children,
  wide = false,
  info,
}: {
  label: ReactNode;
  htmlFor: string;
  children: ReactNode;
  wide?: boolean;
  info?: ReactNode;
}) {
  return (
    <div className={wide ? 'filter-field is-wide' : 'filter-field'}>
      <span className="filter-field-label">
        <label htmlFor={htmlFor}>{label}</label>
        {info}
      </span>
      {children}
    </div>
  );
}
