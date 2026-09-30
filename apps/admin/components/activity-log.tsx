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
 * A detail screen's "Neler oldu" tab (ADMIN-DESIGN-001 Faz 3F.1): the design's
 * Zaman · Yapılan iş · Yapan table.
 *
 * It draws only what the screen hands it, newest first, and the screen hands it
 * only instants the records themselves store (created, last changed, an
 * invitation issued, used or withdrawn). Where no change history is kept — the
 * catalogue tables have none — the footnote says so, so an operator never
 * reads "Son değişiklik" as the only change there ever was.
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

/**
 * "Oluşturuldu" and, when it differs, "Son değişiklik" — the two instants every
 * catalogue row carries. A save that changed nothing still moves `updatedAt`,
 * so the second entry says *that* the record was saved, not *what* changed.
 */
export function recordLifecycleEntries({
  createdAt,
  updatedAt,
  created,
  updated,
}: {
  createdAt: string;
  updatedAt: string;
  created: ReactNode;
  updated: ReactNode;
}): ActivityEntry[] {
  const entries: ActivityEntry[] = [{ key: 'created', at: createdAt, title: created, actor: null }];
  // Prisma stamps both columns with the same instant on create, so any later
  // `updatedAt` is a save — however soon after the create it came.
  if (Date.parse(updatedAt) > Date.parse(createdAt)) {
    entries.push({ key: 'updated', at: updatedAt, title: updated, actor: null });
  }
  return entries;
}

/** The sentence under every catalogue "Neler oldu": what is and is not recorded. */
export const NO_CHANGE_HISTORY_NOTE =
  'Bu kayıt için alan değişikliklerinin geçmişi tutulmuyor; burada yalnız kayıtların kendi tuttuğu zamanlar görünür. "Son güncellendi" satırı kaydın en son ne zaman değiştiğini söyler, neyin değiştiğini ve kimin değiştirdiğini söylemez.';
