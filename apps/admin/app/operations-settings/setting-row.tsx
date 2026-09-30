import type { ReactNode } from 'react';
import { formatDateTime, type OperationsSettingsChange } from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';

/**
 * The pieces of the design's settings screen (`settings`, ADMIN-DESIGN-001
 * Faz 3E): a titled group, and in it one row per real setting — its name,
 * a state badge, what it does, a "ne olur" disclosure and, on the right, the
 * setting's own control. Each row saves itself through its own form and its
 * own permission; there is no shared save bar, because no two settings here
 * share a route, a permission or an audit line.
 *
 * They only lay things out: whether a control is drawn, and what it posts, is
 * decided by the page and the setting's own component.
 */

export function SettingsGroup({
  id,
  title,
  subtitle,
  info,
  children,
  testId,
}: {
  id?: string;
  title: string;
  subtitle?: ReactNode;
  /** An ⓘ beside the title, for how the whole group works. */
  info?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const headingId = `${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-baslik`;
  return (
    <section className="settings-group" id={id} aria-labelledby={headingId} data-testid={testId}>
      <header className="settings-group-head">
        <div className="settings-group-title-row">
          <h2 className="settings-group-title" id={headingId}>
            {title}
          </h2>
          {info}
        </div>
        {subtitle ? <p className="settings-group-subtitle">{subtitle}</p> : null}
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function SettingRow({
  id,
  as: Tag = 'div',
  name,
  badge,
  description,
  whatHappens,
  meta,
  warning,
  control,
  children,
  testId,
}: {
  id?: string;
  /** `li` inside a list of rows (the jobs). */
  as?: 'div' | 'li';
  name: ReactNode;
  /** The state badge beside the name, already carrying its own test id. */
  badge: ReactNode;
  description: ReactNode;
  whatHappens?: { question: string; answer: ReactNode };
  /** Small facts under the text (cron, last run, who saved). */
  meta?: ReactNode;
  /** Read before the control is used, not after (the money jobs). */
  warning?: ReactNode;
  /** The setting's own control; omitted when the session may not change it. */
  control?: ReactNode;
  /** Anything else the row carries under its text. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <Tag className="setting-row" id={id} data-testid={testId}>
      <div className="setting-row-text">
        <div className="setting-row-name-line">
          <h3 className="setting-row-name">{name}</h3>
          {badge}
        </div>
        <p className="setting-row-description">{description}</p>
        {meta ? <div className="setting-row-meta">{meta}</div> : null}
        {warning ? (
          <p className="setting-row-warning" role="note">
            {warning}
          </p>
        ) : null}
        {whatHappens ? <WhatHappens question={whatHappens.question}>{whatHappens.answer}</WhatHappens> : null}
        {children}
      </div>
      {control ? <div className="setting-row-control">{control}</div> : null}
    </Tag>
  );
}

/**
 * The design's red "ⓘ Kapatırsam ne olur?" line: a native disclosure, so the
 * answer is one click (or Enter) away, needs no script, and is in the page
 * for a screen reader and for search from the first render.
 */
export function WhatHappens({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="what-happens">
      <summary>
        <span className="what-happens-mark" aria-hidden="true">
          i
        </span>
        {question}
      </summary>
      <div className="what-happens-body">{children}</div>
    </details>
  );
}

/** `true`/`false` as the audit trail stores them, in the panel's own words. */
export function switchStateLabel(value: string): string {
  return value === 'true' ? 'Açık' : 'Kapalı';
}

const AUDIT_COLUMNS: DataColumn[] = [
  { key: 'from', label: 'Eski' },
  { key: 'to', label: 'Yeni' },
  { key: 'by', label: 'Yönetici' },
  { key: 'at', label: 'Zaman' },
];

/**
 * One of the five change lists under "Neler oldu". Each keeps the test id,
 * the empty sentence and the columns its card used to have; `setting` adds
 * the column naming which setting changed, for the lists that hold several.
 */
export function AuditTable({
  title,
  changes,
  caption,
  testId,
  emptyText,
  emptyTestId,
  settingLabel,
  formatValue,
  formatPrevious,
}: {
  title: string;
  changes: OperationsSettingsChange[];
  caption: string;
  testId: string;
  emptyText: string;
  emptyTestId?: string;
  /** When set, a first "Ayar" column reads each row's setting through it. */
  settingLabel?: (setting: string) => string;
  formatValue: (value: string) => ReactNode;
  /** The previous value; `null` is "the product default". */
  formatPrevious: (value: string | null) => ReactNode;
}) {
  const columns = settingLabel ? [{ key: 'setting', label: 'Ayar' }, ...AUDIT_COLUMNS] : AUDIT_COLUMNS;
  return (
    <div className="settings-audit">
      <h3 className="settings-audit-title">{title}</h3>
      {changes.length === 0 ? (
        <p className="detail-muted-note" data-testid={emptyTestId}>
          {emptyText}
        </p>
      ) : (
        <DataTable caption={caption} columns={columns} minWidth={settingLabel ? 720 : 560} testId={testId}>
          {changes.map((change) => (
            <tr key={change.id}>
              {settingLabel ? <td>{settingLabel(change.setting)}</td> : null}
              <td>{formatPrevious(change.previousValue)}</td>
              <td>{formatValue(change.newValue)}</td>
              <td>{change.changedBy?.name ?? '-'}</td>
              <td className="cell-nowrap">{formatDateTime(change.createdAt)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
