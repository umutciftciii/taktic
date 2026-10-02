import type { ReactNode } from 'react';
import { formatDateTime } from '../lib/api';
import { DataTable, type DataColumn } from './data-table';
import { EmptyState } from './empty-state';
import { SectionCard } from './section-card';

export type ActivityEntry = {
  key: string;
  /** The ISO instant the record itself carries — never a guess. */
  at: string;
  title: ReactNode;
  note?: ReactNode;
  /**
   * Who did it, when the record names them. `null` when it does not: the cell
   * then says so rather than leaving a blank that reads as "nobody".
   */
  actor?: ReactNode | null;
};

const COLUMNS: DataColumn[] = [
  { key: 'when', label: 'Zaman' },
  { key: 'what', label: 'Yapılan iş' },
  { key: 'who', label: 'Yapan' },
];

/**
 * A detail screen's Zaman · Yapılan iş · Yapan table (ADMIN-DESIGN-001 Faz
 * 3F.1), for events a screen assembles from the instants records store (an
 * invitation issued, used or withdrawn).
 *
 * It draws only what the screen hands it, newest first. A record with an audit
 * trail is drawn by `AuditTimeline` instead (ADMIN-ACTION-AUDIT-001), which
 * shows what changed and who changed it rather than when a row was last saved.
 */
export function ActivityLog({
  entries,
  meta,
  footnote,
  testId,
}: {
  entries: ActivityEntry[];
  /** The card header's right-hand line ("Pakette yapılan değişiklikler"). */
  meta?: ReactNode;
  footnote?: ReactNode;
  testId?: string;
}) {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));

  return (
    <SectionCard
      title="Neler oldu"
      actions={meta ? <span className="section-card-meta">{meta}</span> : undefined}
      padded={false}
      className="detail-tab-card"
      testId={testId}
    >
      {sorted.length === 0 ? (
        <EmptyState title="Kayıtlı bir olay yok." />
      ) : (
        <DataTable caption="Neler oldu" columns={COLUMNS} minWidth={560}>
          {sorted.map((entry) => (
            <tr key={entry.key} data-testid="activity-row">
              <td className="cell-nowrap">
                <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
              </td>
              <td>
                <div className="cell-stack">
                  <strong className="cell-break">{entry.title}</strong>
                  {entry.note ? <span className="cell-muted cell-break">{entry.note}</span> : null}
                </div>
              </td>
              <td className="cell-break">
                {entry.actor ?? <span className="cell-muted">Kayıtlı değil</span>}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {footnote ? (
        <p className="detail-card-footnote" data-testid={testId ? `${testId}-footnote` : undefined}>
          {footnote}
        </p>
      ) : null}
    </SectionCard>
  );
}
