import type { ReactNode } from 'react';

export type TimelineItem = {
  key: string;
  /** Already formatted for display ("19 Eyl 14:32"). */
  when: string;
  /** The machine-readable instant behind `when`. */
  dateTime?: string;
  title: ReactNode;
  /** Who did it, when that is known. */
  actor?: ReactNode;
  note?: ReactNode;
};

/**
 * "Neler oldu": what happened to a record, in order. An ordered list with a
 * `<time>` per entry; the screen decides the order (the API's, usually newest
 * first) and this only draws it. With nothing to show it renders `empty`.
 */
export function Timeline({ items, empty = null }: { items: TimelineItem[]; empty?: ReactNode }) {
  if (items.length === 0) return <>{empty}</>;

  return (
    <ol className="timeline">
      {items.map((item) => (
        <li className="timeline-item" key={item.key}>
          <time className="timeline-when" dateTime={item.dateTime}>
            {item.when}
          </time>
          <div className="timeline-body">
            <p className="timeline-title">{item.title}</p>
            {item.actor ? <p className="timeline-meta">{item.actor}</p> : null}
            {item.note ? <p className="timeline-meta">{item.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
