import type { ReactNode } from 'react';

export type KeyValueItem = {
  label: ReactNode;
  /** `null`/`undefined` renders the panel's "—", never an empty cell. */
  value: ReactNode;
  testId?: string;
};

/**
 * Label / value rows inside a detail card. Side by side where there is room,
 * stacked on a phone; long values (ids, addresses) wrap inside their column.
 */
export function KeyValueList({ items }: { items: KeyValueItem[] }) {
  return (
    <dl className="kv-list">
      {items.map((item, index) => (
        <div className="kv-row" key={index}>
          <dt>{item.label}</dt>
          <dd data-testid={item.testId}>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
