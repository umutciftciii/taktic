import type { CSSProperties, ReactNode } from 'react';

export type DataColumn = {
  key: string;
  label: ReactNode;
  /** `end` for numbers: right-aligned, tabular figures. */
  align?: 'start' | 'end';
  /** A header only a screen reader needs (the actions column). */
  srOnly?: boolean;
};

/**
 * The design's full-width list table.
 *
 * The rows stay with the screen — only it knows its cells — but the frame is
 * shared: an 11px uppercase header over a 2px ink rule, row hover, numbers on
 * the right, and a scroll container of its own. That container is the part
 * that matters most on a phone: the table keeps its columns and scrolls
 * sideways inside it, and the page itself never gets wider than the window.
 * It is a named, focusable region, so the sideways scroll is reachable from
 * the keyboard too.
 */
export function DataTable({
  caption,
  columns,
  children,
  minWidth,
  testId,
}: {
  /** Names the table and its scroll region for assistive technology. */
  caption: string;
  columns: DataColumn[];
  children: ReactNode;
  /** Below this width the table scrolls instead of squeezing (default 960px). */
  minWidth?: number;
  testId?: string;
}) {
  return (
    <div className="table-scroll data-list-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table
        className="data-table data-list"
        data-testid={testId}
        style={minWidth ? ({ '--data-list-min-width': `${minWidth}px` } as CSSProperties) : undefined}
      >
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === 'end' ? 'is-num' : undefined}>
                {column.srOnly ? <span className="sr-only">{column.label}</span> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
