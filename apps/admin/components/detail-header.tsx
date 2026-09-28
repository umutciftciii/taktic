import Link from 'next/link';
import type { ReactNode } from 'react';
import { SummaryStrip, type SummaryItem } from './summary-strip';

type DetailHeaderProps = {
  /**
   * "‹ Tüm talepler": where the list this record came from lives. Omitted when
   * the session may not open that list — a link that ends on /yetkisiz is not
   * a way back.
   */
  back?: { href: string; label: string } | null;
  /** Status badges, first on the card. */
  badges?: ReactNode;
  /** The record's number and when it was made ("TL-24817 · 19 Eyl 14:32'de geldi"). */
  meta?: ReactNode;
  title: ReactNode;
  /** One line under the title (who, where). */
  subtitle?: ReactNode;
  /** Buttons and links for the whole record; each one already gated by the screen. */
  actions?: ReactNode;
  /** The summary strip under the card. Omitted or empty, no strip is drawn. */
  facts?: SummaryItem[];
  factsLabel?: string;
  testId?: string;
};

/**
 * The top of a detail screen, the design's "özet kartı": a way back to the
 * list, the record's badges and number, its 27px title, the actions that
 * belong to the whole record and, under them, the summary strip.
 *
 * It only lays things out. Every badge, figure and action it is given is the
 * screen's, and the screen decides what a session may see and do — the header
 * never adds a control of its own.
 */
export function DetailHeader({
  back,
  badges,
  meta,
  title,
  subtitle,
  actions,
  facts,
  factsLabel,
  testId,
}: DetailHeaderProps) {
  return (
    <header className="detail-header" data-testid={testId}>
      {back ? (
        <Link className="detail-back" href={back.href}>
          <span aria-hidden="true">‹</span> {back.label}
        </Link>
      ) : null}
      <section className="detail-card">
        <div className="detail-card-main">
          <div className="detail-card-text">
            {badges || meta ? (
              <div className="detail-card-badges">
                {badges}
                {meta ? <span className="detail-card-meta">{meta}</span> : null}
              </div>
            ) : null}
            <h1 className="detail-card-title">{title}</h1>
            {subtitle ? <p className="detail-card-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="detail-card-actions">{actions}</div> : null}
        </div>
        {facts && facts.length > 0 ? <SummaryStrip items={facts} label={factsLabel} /> : null}
      </section>
    </header>
  );
}
