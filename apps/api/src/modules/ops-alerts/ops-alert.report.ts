import {
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertEmailRouting,
  OpsAlertNoticeKind,
  OpsAlertRecipientStatus,
  OpsAlertSeverity,
  OpsAlertSource,
  OpsAlertState,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { readOpsAlertCron } from '../../common/scheduler-cron';
import type { HealthStatus } from '../system-health/system-health.rules';
import { OpsAlertChannelStatus, opsAlertChannelStatus } from './ops-alert.config';
import { EngineReason, OPS_ALERT_ENGINE_STATE_ID, evaluateEngine } from './ops-alert.rules';
import { OPS_ALERT_ROUTING_ID } from './ops-alert-recipient.constants';

/**
 * OBS-ALERT-001 — the "Operasyon alarmları" block of the system health report.
 *
 * Read-only, and an allow-list: the alert's key, codes, counts and times, and
 * per notice the channel, state and attempt count. Never a recipient's
 * address (OBS-ALERT-002: an e-mail notice names its managed recipient by id
 * and label only), a chat id, a token or a message. E-mail alerts are left
 * out entirely — absent, not filtered after reading — for a caller without
 * NOTIFICATION_LOGS_READ, the same split the e-mail section has.
 *
 * OBS-ALERT-002: who the managed recipients are — a delivery's recipient id
 * and label, and the live recipient count — is OPS_ALERT_RECIPIENTS_READ
 * data. Without it the fields are not selected at all and answer null (the
 * keys stay, so the response shape is one shape for every caller).
 *
 * The engine row answers whether the evaluator itself runs: its last
 * successful evaluation, judged by the scheduler screen's missed-tick rule.
 * An engine that stopped cannot alert about itself; this is where it shows.
 */

/** Recently closed alerts are listed for this long, at most this many. */
export const RESOLVED_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const ALERT_LIST_LIMIT = 10;

/** When this process started: the engine cannot be late before it could run. */
const PROCESS_STARTED_AT = new Date();

export type OpsAlertDeliveryView = {
  kind: OpsAlertNoticeKind;
  sequence: number;
  channel: OpsAlertChannel;
  status: OpsAlertDeliveryStatus;
  attemptCount: number;
  sentAt: string | null;
  errorCode: string | null;
  /**
   * OBS-ALERT-002: the managed recipient this e-mail is bound to; null for
   * Telegram and OPS_ALERT_EMAIL rows, and for every row when the caller
   * lacks OPS_ALERT_RECIPIENTS_READ.
   */
  recipientId: string | null;
  /** That recipient's label — never its address, masked or not. Null under the same rules as recipientId. */
  recipientLabel: string | null;
};

/**
 * OBS-ALERT-002: which e-mail routing is in force and how many managed
 * recipients are live (not DELETED). Both null when the report could not be
 * read (QUERY_FAILED); `managedRecipients` is also null for a caller without
 * OPS_ALERT_RECIPIENTS_READ.
 */
export type OpsAlertChannelsView = OpsAlertChannelStatus & {
  emailRouting: OpsAlertEmailRouting | null;
  managedRecipients: number | null;
};

export type OpsAlertView = {
  ref: string;
  source: OpsAlertSource;
  subjectKey: string;
  condition: string;
  severity: OpsAlertSeverity;
  state: OpsAlertState;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  resolvedAt: string | null;
  resolution: string | null;
  deliveries: OpsAlertDeliveryView[];
};

export type OpsAlertsReport = {
  /** The engine's own state; the alerts themselves are listed, not scored. */
  status: HealthStatus;
  reason: EngineReason | 'QUERY_FAILED';
  checkedAt: string;
  engine: {
    cron: string;
    missedTicks: number;
    lastStartedAt: string | null;
    lastSucceededAt: string | null;
    lastFailedAt: string | null;
    /** DATABASE_ERROR | APPLICATION_ERROR — never a class name or message. */
    lastErrorType: string | null;
  };
  channels: OpsAlertChannelsView;
  open: OpsAlertView[];
  recentlyResolved: OpsAlertView[];
};

const deliverySelect = {
  kind: true,
  sequence: true,
  channel: true,
  status: true,
  attemptCount: true,
  sentAt: true,
  errorCode: true,
} as const;

const alertBaseSelect = {
  ref: true,
  source: true,
  subjectKey: true,
  condition: true,
  severity: true,
  state: true,
  firstSeenAt: true,
  lastSeenAt: true,
  occurrenceCount: true,
  resolvedAt: true,
  resolution: true,
} as const;

/** The recipient link is read only for an OPS_ALERT_RECIPIENTS_READ holder; otherwise it is never selected. */
function alertSelect(includeRecipients: boolean): Prisma.OpsAlertSelect {
  return {
    ...alertBaseSelect,
    deliveries: {
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: includeRecipients
        ? { ...deliverySelect, recipientId: true, recipient: { select: { label: true } } }
        : deliverySelect,
    },
  };
}

type AlertRow = {
  ref: string;
  source: OpsAlertSource;
  subjectKey: string;
  condition: string;
  severity: OpsAlertSeverity;
  state: OpsAlertState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  resolvedAt: Date | null;
  resolution: string | null;
  deliveries: Array<{
    kind: OpsAlertNoticeKind;
    sequence: number;
    channel: OpsAlertChannel;
    status: OpsAlertDeliveryStatus;
    attemptCount: number;
    sentAt: Date | null;
    errorCode: string | null;
    recipientId?: string | null;
    recipient?: { label: string } | null;
  }>;
};

function view(row: AlertRow): OpsAlertView {
  return {
    ref: row.ref,
    source: row.source,
    subjectKey: row.subjectKey,
    condition: row.condition,
    severity: row.severity,
    state: row.state,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    occurrenceCount: row.occurrenceCount,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution,
    deliveries: row.deliveries.map((delivery) => ({
      kind: delivery.kind,
      sequence: delivery.sequence,
      channel: delivery.channel,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      sentAt: delivery.sentAt?.toISOString() ?? null,
      errorCode: delivery.errorCode,
      recipientId: delivery.recipientId ?? null,
      recipientLabel: delivery.recipient?.label ?? null,
    })),
  };
}

export async function readOpsAlertsReport(
  prisma: Pick<PrismaClient, 'opsAlert' | 'opsAlertEngineState' | 'opsAlertRoutingSettings' | 'opsAlertRecipient'>,
  options: { includeEmail: boolean; includeRecipients: boolean },
  now: Date = new Date(),
): Promise<OpsAlertsReport> {
  const sources = options.includeEmail ? [OpsAlertSource.SCHEDULER, OpsAlertSource.EMAIL] : [OpsAlertSource.SCHEDULER];
  const [state, open, resolved, routing, managedRecipients] = await Promise.all([
    prisma.opsAlertEngineState.findUnique({
      where: { id: OPS_ALERT_ENGINE_STATE_ID },
      select: { lastStartedAt: true, lastSucceededAt: true, lastFailedAt: true, lastErrorType: true },
    }),
    prisma.opsAlert.findMany({
      where: { state: OpsAlertState.OPEN, source: { in: sources } },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: ALERT_LIST_LIMIT,
      select: alertSelect(options.includeRecipients),
    }) as Promise<AlertRow[]>,
    prisma.opsAlert.findMany({
      where: {
        state: OpsAlertState.RESOLVED,
        source: { in: sources },
        resolvedAt: { gte: new Date(now.getTime() - RESOLVED_WINDOW_MS) },
      },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
      take: ALERT_LIST_LIMIT,
      select: alertSelect(options.includeRecipients),
    }) as Promise<AlertRow[]>,
    prisma.opsAlertRoutingSettings.findUnique({ where: { id: OPS_ALERT_ROUTING_ID }, select: { emailRouting: true } }),
    options.includeRecipients
      ? prisma.opsAlertRecipient.count({ where: { status: { not: OpsAlertRecipientStatus.DELETED } } })
      : null,
  ]);

  const cron = readOpsAlertCron();
  const engine = evaluateEngine(state, cron, now, PROCESS_STARTED_AT);
  return {
    status: engine.status,
    reason: engine.reason,
    checkedAt: now.toISOString(),
    engine: {
      cron,
      missedTicks: engine.missedTicks,
      lastStartedAt: state?.lastStartedAt?.toISOString() ?? null,
      lastSucceededAt: state?.lastSucceededAt?.toISOString() ?? null,
      lastFailedAt: state?.lastFailedAt?.toISOString() ?? null,
      lastErrorType: state?.lastErrorType ?? null,
    },
    channels: {
      ...opsAlertChannelStatus(),
      emailRouting: routing?.emailRouting ?? OpsAlertEmailRouting.ENV_LEGACY,
      managedRecipients,
    },
    open: open.map(view),
    recentlyResolved: resolved.map(view),
  };
}
