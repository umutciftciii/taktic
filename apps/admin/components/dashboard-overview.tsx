import Link from 'next/link';
import type { ReactNode } from 'react';
import type {
  DashboardKpi,
  DashboardKpiNote,
  DashboardQueueCell,
  SystemActivityRow,
} from '../lib/dashboard-overview';
import { formatCount } from '../lib/pagination';
import { InfoPopover } from './info-popover';

/**
 * The dashboard's three blocks (design `dashboard`, ADMIN-DESIGN-001 Faz 3H).
 * They draw what `lib/dashboard-overview.ts` decided and nothing else: no
 * block looks at a number to pick a colour, because the tone arrives resolved
 * from `dashboard-metrics.ts`.
 */

function OverviewCard({
  title,
  info,
  infoLabel,
  meta,
  children,
  className,
  testId,
}: {
  title: string;
  info: ReactNode;
  infoLabel: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  testId: string;
}) {
  const headingId = `${testId}-title`;
  return (
    <section
      className={['dashboard-card', className].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <header className="dashboard-card-header">
        <div className="dashboard-card-heading">
          <h2 id={headingId} className="dashboard-card-title">
            {title}
          </h2>
          <InfoPopover label={infoLabel} size="sm">
            {info}
          </InfoPopover>
        </div>
        {meta ? <p className="dashboard-card-meta">{meta}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * "Önce bunlara bak": one link per queue the session may open. The number
 * leads the link's accessible name ("3 Şikayet: Karar bekleyen talep
 * bildirimi"), so a screen reader hears what a sighted operator reads.
 */
export function DashboardQueues({ cells }: { cells: DashboardQueueCell[] }) {
  return (
    <OverviewCard
      title="Önce bunlara bak"
      infoLabel="Bu kutular neyi sayıyor?"
      info={
        <>
          Her kutu bir kuyruğun bekleyen işini sayar ve tıklayınca o kuyruğu aynı filtreyle açar; kutudaki sayı,
          açılan listedeki kayıtların sayısıdır. Yalnız açmaya yetkiniz olan kuyruklar görünür. Şikayet sayısı bildirim
          başınadır: aynı talebe gelen bildirimler listede tek satırdadır ve satırların “Bildirim” sütunu toplamı bu
          sayıya eşittir. Sayılar sayfayı her açtığınızda yeniden okunur.
        </>
      }
      className="is-emphasis"
      testId="dashboard-queues"
    >
      <ul className="dashboard-queue-grid" role="list">
        {cells.map((cell) => (
          <li key={cell.metricKey} className="dashboard-queue-item">
            <Link
              className="dashboard-queue-cell"
              href={cell.href}
              data-testid="dashboard-queue"
              data-metric={cell.metricKey}
              data-tone={cell.tone}
            >
              <span className="dashboard-queue-top">
                <span className="dashboard-queue-value" data-testid="dashboard-queue-value">
                  {formatCount(cell.value)}
                </span>
                <span className="dashboard-queue-kicker">{cell.kicker}</span>
              </span>
              <span className="dashboard-queue-title">{cell.title}</span>
              <span className="dashboard-queue-description">{cell.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </OverviewCard>
  );
}

function KpiNote({ note }: { note: DashboardKpiNote }) {
  const body = (
    <>
      <strong>{formatCount(note.value)}</strong> {note.text}
    </>
  );
  const common = {
    className: 'dashboard-kpi-note',
    'data-testid': 'dashboard-kpi-note',
    'data-metric': note.metricKey,
    'data-tone': note.tone,
  };
  return note.href ? (
    <Link href={note.href} {...common}>
      {body}
    </Link>
  ) : (
    <span {...common}>{body}</span>
  );
}

/**
 * The four headline figures. A description list, so each figure is read with
 * its label; the label is the link when the session may open the list.
 */
export function DashboardKpis({ kpis }: { kpis: DashboardKpi[] }) {
  return (
    <dl className="dashboard-kpi-row" aria-label="Temel sayılar">
      {kpis.map((kpi) => (
        <div key={kpi.metricKey} className="dashboard-kpi" data-testid="dashboard-kpi" data-metric={kpi.metricKey}>
          <dt className="dashboard-kpi-label">
            {kpi.href ? <Link href={kpi.href}>{kpi.label}</Link> : kpi.label}
          </dt>
          <dd className="dashboard-kpi-value" data-testid="dashboard-kpi-value">
            {formatCount(kpi.value)}
          </dd>
          {kpi.notes.length > 0 ? (
            <dd className="dashboard-kpi-notes">
              {kpi.notes.map((note) => (
                <KpiNote key={note.metricKey} note={note} />
              ))}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

const ACTIVITY_BADGE: Record<SystemActivityRow['tone'], string> = {
  on: 'badge badge-good',
  off: 'badge badge-muted',
  failed: 'badge badge-bad',
  value: 'badge',
};

/** "Sistem şu anda ne yapıyor", from the operations settings reads. */
export function DashboardSystemActivity({
  rows,
  settingsHref,
}: {
  rows: SystemActivityRow[];
  settingsHref: string;
}) {
  return (
    <OverviewCard
      title="Sistem şu anda ne yapıyor"
      infoLabel="Bu liste nereden geliyor?"
      info={
        <>
          Platformun kendi başına yaptığı işler ve açık ya da kapalı oldukları; Operasyon ayarları ekranındaki
          değerlerin aynısıdır. “Kapalı” bir arıza değildir, işin çalışmadığını söyler. Zamanlanmış bir işin son
          çalışması, yanıtı veren API sürecinin kaydıdır; süreç yeniden başladıysa henüz kayıt olmayabilir.
        </>
      }
      meta={<Link href={settingsHref}>Operasyon ayarlarını aç</Link>}
      testId="dashboard-system"
    >
      <ul className="dashboard-activity-list" role="list">
        {rows.map((row) => (
          <li key={row.key} className="dashboard-activity" data-testid="dashboard-activity" data-key={row.key} data-tone={row.tone}>
            <span className="dashboard-activity-dot" aria-hidden="true" />
            <span className="dashboard-activity-text">
              <span className="dashboard-activity-name">{row.name}</span>
              <span className="dashboard-activity-description">{row.description}</span>
              {row.detail ? <span className="dashboard-activity-detail">{row.detail}</span> : null}
            </span>
            <span className={ACTIVITY_BADGE[row.tone]} data-testid="dashboard-activity-state">
              {row.state}
            </span>
          </li>
        ))}
      </ul>
    </OverviewCard>
  );
}
