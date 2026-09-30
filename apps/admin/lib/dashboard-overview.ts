import type {
  AdminPermission,
  CampaignEngineSettings,
  MarketplacePublishSettings,
  OperationsSettings,
  ProviderReviewSettings,
  SchedulerSettings,
} from './api';
import { SCHEDULER_JOB_COPY } from './api';
import type { AdminDashboardMetric, AdminMetricTone } from './dashboard-metrics';

/**
 * Genel görünüm (`/`), design `dashboard` (ADMIN-DESIGN-001 Faz 3H).
 *
 * Everything the screen decides, as functions of what it read: the summary
 * (`GET /dashboard/admin-summary`, through `buildAdminDashboardMetrics`), the
 * session's permissions, the signed-in account and — only when the session may
 * read them — the operations settings. The page renders what these return and
 * adds nothing of its own, so the tests below pin the screen rather than a
 * restatement of it.
 *
 * Two decisions shape it (screen mapping §6):
 *
 * - **K2.** The summary is `DASHBOARD_READ`, but a queue's number is a fact
 *   about the queue. A cell is drawn only for a session that may open the list
 *   behind it; one that may not is not shown a number it could not follow.
 * - **K12.** No figure without a source. The design's week-over-week change,
 *   sparklines, "Son 7 gün" chart, "N dakika önce güncellendi", "Panelde son
 *   yapılanlar" feed, vitrin queue and the total of waiting work are not
 *   drawn: the API has no series, no global audit feed and no showcase count
 *   in the summary, and a sum of reports, applications and tickets is not a
 *   number any list shows.
 */

/**
 * The permission each destination page asks for in its own `requireAdmin`.
 *
 * The numbers are all covered by DASHBOARD_READ; following one into its list is
 * not. A link whose page would answer /yetkisiz is not drawn as a link.
 * Longest prefix first, so `/requests/reports` is not read as `/requests`. An
 * unknown destination is not linked — a new link has to be added here.
 */
export const DESTINATION_PERMISSIONS: ReadonlyArray<readonly [string, AdminPermission]> = [
  ['/requests/reports', 'REQUEST_REPORTS_READ'],
  ['/requests', 'REQUESTS_READ'],
  ['/providers', 'PROVIDERS_READ'],
  ['/offers', 'OFFERS_READ'],
  ['/package-purchases', 'PACKAGE_PURCHASES_READ'],
  ['/refund-scan', 'OFFER_REFUND_SCAN_READ'],
  ['/support', 'SUPPORT_READ'],
  ['/operations-settings', 'OPERATIONS_SETTINGS_READ'],
];

export function destinationPermission(href: string): AdminPermission | null {
  const path = href.split(/[?#]/, 1)[0] ?? href;
  const match = DESTINATION_PERMISSIONS.find(
    ([prefix]) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return match ? match[1] : null;
}

export type Can = (permission: AdminPermission) => boolean;

/** The href when the session may open it, otherwise null. */
export function linkIfAllowed(href: string, can: Can): string | null {
  const permission = destinationPermission(href);
  return permission !== null && can(permission) ? href : null;
}

function requireMetric(metrics: readonly AdminDashboardMetric[], key: string): AdminDashboardMetric {
  const found = metrics.find((metric) => metric.key === key);
  if (!found) throw new Error(`No dashboard metric named "${key}"`);
  return found;
}

/* ---- Önce bunlara bak --------------------------------------------------- */

export type DashboardQueueCell = {
  metricKey: string;
  value: number;
  /** The design's small coloured word over the job name. */
  kicker: string;
  title: string;
  description: string;
  href: string;
  /** From `dashboard-metrics.ts`: `neutral` at zero, never decided here. */
  tone: AdminMetricTone;
};

type QueueDefinition = Omit<DashboardQueueCell, 'value' | 'href' | 'tone'>;

/**
 * The queues the summary counts, in the design's order. The design's fourth
 * cell, "Onay bekleyen vitrin kartı", is not here: the summary has no showcase
 * count, and the cell stays out until the endpoint carries one.
 *
 * Each description says what the number counts in the list's own terms. The
 * report cell says so twice over, because its number is reports while its list
 * is requests: three providers reporting one request is 3 here and one row
 * there, whose "Bildirim" column reads 3.
 */
const QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    metricKey: 'pendingProviders',
    kicker: 'Başvuru',
    title: 'Onay bekleyen işletme',
    description: 'Karar verilene kadar iş alamazlar. Liste “İnceleme bekliyor” görünümünde açılır.',
  },
  {
    metricKey: 'openRequestReports',
    kicker: 'Şikayet',
    title: 'Karar bekleyen talep bildirimi',
    description:
      'Bildirim başına sayılır; aynı talebe gelen bildirimler listede tek satırda, “Bildirim” sütununda toplanır.',
  },
  {
    metricKey: 'openSupportTickets',
    kicker: 'Destek',
    title: 'Açık destek talebi',
    description: 'Yanıt bekleyen ve üzerinde çalışılan talepler; çözülen ve kapanan sayılmaz.',
  },
];

/**
 * The cells this session may see. A cell is its link: one whose list the
 * session cannot open is left out whole (K2), never drawn as a bare number.
 * An empty result means the card is not drawn at all.
 */
export function buildDashboardQueues(
  metrics: readonly AdminDashboardMetric[],
  can: Can,
): DashboardQueueCell[] {
  return QUEUE_DEFINITIONS.flatMap((definition) => {
    const metric = requireMetric(metrics, definition.metricKey);
    const href = linkIfAllowed(metric.href, can);
    if (!href) return [];
    return [{ ...definition, value: metric.value, href, tone: metric.tone }];
  });
}

/* ---- KPI ---------------------------------------------------------------- */

export type DashboardKpiNote = {
  metricKey: string;
  value: number;
  /** Follows the number: "3 onay bekliyor". */
  text: string;
  href: string | null;
  tone: AdminMetricTone;
};

export type DashboardKpi = {
  metricKey: string;
  label: string;
  value: number;
  href: string | null;
  notes: DashboardKpiNote[];
};

type KpiDefinition = {
  metricKey: string;
  label: string;
  notes: ReadonlyArray<{ metricKey: string; text: string }>;
};

/**
 * The four headline figures, chosen from the summary: requests, offers,
 * approved providers, package purchases. Each is a standing count and
 * never carries a badge (dashboard-metrics rule 1).
 *
 * The design's KPIs — this week's requests, offer count with a change, match
 * rate, credit sales in lira — have no source in the summary, and neither do
 * their change figures or sparklines; they are not approximated. The summary's
 * remaining action counts ride under the figure they belong to, each linked to
 * the exact status view it counts and toned by the same rule as every card.
 */
const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  {
    metricKey: 'totalRequests',
    label: 'Toplam talep',
    notes: [
      { metricKey: 'pendingRequests', text: 'onay bekliyor' },
      { metricKey: 'inReviewRequests', text: 'incelemede' },
    ],
  },
  {
    metricKey: 'totalOffers',
    label: 'Toplam teklif',
    notes: [{ metricKey: 'refundableOffers', text: 'iade adayı' }],
  },
  { metricKey: 'approvedProviders', label: 'Onaylı hizmet veren', notes: [] },
  { metricKey: 'packagePurchases', label: 'Paket satın alma', notes: [] },
];

export function buildDashboardKpis(
  metrics: readonly AdminDashboardMetric[],
  can: Can,
): DashboardKpi[] {
  return KPI_DEFINITIONS.map((definition) => {
    const metric = requireMetric(metrics, definition.metricKey);
    return {
      metricKey: metric.key,
      label: definition.label,
      value: metric.value,
      href: linkIfAllowed(kpiHref(metric), can),
      notes: definition.notes.map((note) => {
        const noteMetric = requireMetric(metrics, note.metricKey);
        return {
          metricKey: noteMetric.key,
          value: noteMetric.value,
          text: note.text,
          href: linkIfAllowed(noteMetric.href, can),
          tone: noteMetric.tone,
        };
      }),
    };
  });
}

/**
 * Where a headline figure goes: its list, narrowed to what it counts. Approved
 * providers are the list's APPROVED view, not the whole provider list.
 */
function kpiHref(metric: AdminDashboardMetric): string {
  return metric.key === 'approvedProviders' ? '/providers?status=APPROVED' : metric.href;
}

/* ---- Karşılama ---------------------------------------------------------- */

const TIME_ZONE = 'Europe/Istanbul';

/**
 * "Günaydın, Umut" and "30 Eylül, Çarşamba", from the account and the clock.
 *
 * The name is the account's own `name`, first word; an account without one is
 * greeted without a name rather than by its e-mail address. The hour and the
 * date are Istanbul's, whatever the server's zone — the operators are there.
 */
export function dashboardGreeting(name: string | null | undefined, now: Date) {
  const parts = new Intl.DateTimeFormat('tr-TR', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    hourCycle: 'h23',
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';

  const hour = Number(part('hour'));
  const salutation =
    hour >= 5 && hour < 12 ? 'Günaydın' : hour >= 12 && hour < 18 ? 'İyi günler' : hour >= 18 && hour < 23 ? 'İyi akşamlar' : 'İyi geceler';

  const firstName = (name ?? '').trim().split(/\s+/)[0] ?? '';

  return {
    title: firstName ? `${salutation}, ${firstName}` : salutation,
    date: `${part('day')} ${part('month')}, ${part('weekday')}`,
    /** ISO date for `<time dateTime>`, in the same zone as the text. */
    isoDate: new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now),
  };
}

/* ---- Sistem şu anda ne yapıyor ----------------------------------------- */

/** `value` is a setting that is a quantity rather than a switch: never green or red. */
export type SystemActivityTone = 'on' | 'off' | 'failed' | 'value';

export type SystemActivityRow = {
  key: string;
  name: string;
  description: string;
  /** The badge text: the state the API reported, in the settings screen's words. */
  state: string;
  tone: SystemActivityTone;
  /** A second line, only from a recorded fact (a job's last run). */
  detail: string | null;
};

export type OperationsSnapshot = {
  settings: OperationsSettings;
  schedulers: SchedulerSettings;
  publish: MarketplacePublishSettings;
  reviews: ProviderReviewSettings;
  engine: CampaignEngineSettings;
};

const RUN_OUTCOME: Record<'SUCCESS' | 'FAILED' | 'SKIPPED', string> = {
  SUCCESS: 'tamamlandı',
  FAILED: 'hata verdi',
  SKIPPED: 'atlandı',
};

/**
 * The design's "what is the platform doing on its own" list, derived from the
 * operations settings reads (K12) — the same five endpoints the operations
 * screen reads, behind the same `OPERATIONS_SETTINGS_READ`.
 *
 * "Kapalı" is a state, not an alarm: the settings screen draws it muted and so
 * does this list (the design painted it red; every switch here is off by
 * default and off is a working configuration). Only a job whose last recorded
 * run failed is marked as a problem. The design's "E-posta ve bildirim
 * gönderimi — son 24 saatte 412 bildirim" row has no source among these reads
 * and is not drawn.
 */
export function buildSystemActivity(
  snapshot: OperationsSnapshot,
  formatDateTime: (value: string) => string,
): SystemActivityRow[] {
  const toggle = (
    key: string,
    name: string,
    enabled: boolean,
    on: string,
    off: string,
  ): SystemActivityRow => ({
    key,
    name,
    description: enabled ? on : off,
    state: enabled ? 'Açık' : 'Kapalı',
    tone: enabled ? 'on' : 'off',
    detail: null,
  });

  const rows: SystemActivityRow[] = [
    toggle(
      'auto-publish',
      'Pazar talepleri otomatik yayınlanıyor',
      snapshot.publish.enabled,
      'Yeni talepler moderasyon beklemeden eşleşen hizmet verenlere iletilir.',
      'Yeni talepler onay kuyruğuna düşer; yayına siz alırsınız.',
    ),
    toggle(
      'campaign-engine',
      'Kampanya motoru',
      snapshot.engine.enabled,
      'Aktif kampanyalar gerçek olaylarda promosyon kredisi verebilir.',
      'Yeni olay kaydedilmez; kimseye kampanya kredisi verilmez.',
    ),
    toggle(
      'provider-reviews',
      'Hizmet veren değerlendirmeleri',
      snapshot.reviews.enabled,
      'Tamamlanan işlerde müşteriye değerlendirme daveti gider.',
      'Müşteri değerlendirme yazamaz; mevcut değerlendirmeler gizlidir.',
    ),
    {
      key: 'offer-refund-window',
      name: 'Görüntülenmeyen teklif iade süresi',
      description: 'Müşteri bu süre içinde açmadığı tekliflerin kredisi hizmet verene döner.',
      state: `${snapshot.settings.unviewedOfferRefundWindowHours} saat`,
      tone: 'value',
      detail: snapshot.settings.configured ? null : 'Varsayılan değer; henüz kaydedilmedi.',
    },
  ];

  for (const job of snapshot.schedulers.jobs) {
    const copy = SCHEDULER_JOB_COPY[job.key];
    const failed = job.lastRun?.outcome === 'FAILED';
    rows.push({
      key: `job-${job.key}`,
      name: copy?.name ?? job.key,
      description: copy?.impact ?? '',
      state: failed ? 'Son çalışma hata' : job.enabled ? 'Açık' : 'Kapalı',
      tone: failed ? 'failed' : job.enabled ? 'on' : 'off',
      detail: job.lastRun
        ? `Son çalışma ${formatDateTime(job.lastRun.finishedAt)} · ${RUN_OUTCOME[job.lastRun.outcome]}`
        : null,
    });
  }

  return rows;
}
