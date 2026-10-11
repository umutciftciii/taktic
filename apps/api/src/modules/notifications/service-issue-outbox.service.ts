import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BackgroundRuns, type BackgroundWorkOwner } from '../../common/background-work';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { readSupportInboxEmail } from '../support-tickets/support-inbox.config';
import { recipientFor, TransactionalMailService } from './transactional-mail.service';

/**
 * REL-002 Faz 3 — the notices a service issue owes, as durable intents.
 *
 * Written inside the service-issue transaction, from the incident row that
 * transaction just wrote, so a report that commits always owes them and one
 * that rolls back owes none; sent after the commit by `deliverSoon`, and
 * swept by the request lifecycle tick like the cancellation notices.
 *
 * Every key is the incident (or, for the reopen notice, the new round), so a
 * retried report — which replays the incident instead of writing a second
 * one — enqueues nothing new, and `(template, dedupeKey)` refuses a duplicate
 * in any case. The next round's own publication notices (`request-published`,
 * `request-available:<req>:<provider>:r<N>`) are the publish outbox's, written
 * by the same transaction.
 */
export const SERVICE_ISSUE_NOTIFICATION_TEMPLATES = [
  'service-issue-recorded',
  'request-reopened',
  'request-match-review',
  'provider-incident-opened',
  'provider-incident-new',
] as const;

const DEFAULT_DELIVERY_LIMIT = 200;

/**
 * Writes every notice one service issue owes, inside the caller's transaction:
 *
 * - the customer: the report is on record; then either the request is open
 *   for offers again (`request-reopened`, keyed on the new round) or it waits
 *   for the team (`request-match-review`, Round 3);
 * - the provider whose match failed (no customer detail of any kind);
 * - the support inbox.
 */
export async function enqueueServiceIssueNotices(
  tx: Prisma.TransactionClient,
  input: { incidentId: string; reopenedRoundId: string | null },
): Promise<number> {
  const incident = await tx.providerServiceIncident.findUnique({
    where: { id: input.incidentId },
    select: {
      id: true,
      requestId: true,
      providerId: true,
      request: { select: { customerId: true, customerEmail: true } },
      provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
    },
  });
  if (!incident) {
    return 0;
  }

  const rows: Prisma.NotificationLogCreateManyInput[] = [];
  const customerEmail = incident.request.customerEmail?.trim();
  if (customerEmail) {
    rows.push(
      intentRow({
        template: 'service-issue-recorded',
        to: customerEmail,
        dedupeKey: `service-issue-recorded:${incident.id}`,
        requestId: incident.requestId,
        userId: incident.request.customerId,
        providerId: null,
      }),
    );
    rows.push(
      input.reopenedRoundId
        ? intentRow({
            template: 'request-reopened',
            to: customerEmail,
            dedupeKey: `request-reopened:${input.reopenedRoundId}`,
            requestId: incident.requestId,
            userId: incident.request.customerId,
            providerId: null,
          })
        : intentRow({
            template: 'request-match-review',
            to: customerEmail,
            dedupeKey: `request-match-review:${incident.id}`,
            requestId: incident.requestId,
            userId: incident.request.customerId,
            providerId: null,
          }),
    );
  }

  const providerRecipient = recipientFor(incident.provider);
  if (providerRecipient) {
    rows.push(
      intentRow({
        template: 'provider-incident-opened',
        to: providerRecipient,
        dedupeKey: `provider-incident-opened:${incident.id}`,
        requestId: incident.requestId,
        userId: incident.provider.userId,
        providerId: incident.providerId,
      }),
    );
  }

  const supportInbox = readSupportInboxEmail();
  if (supportInbox) {
    rows.push(
      intentRow({
        template: 'provider-incident-new',
        to: supportInbox,
        dedupeKey: `provider-incident-new:${incident.id}`,
        requestId: incident.requestId,
        userId: null,
        providerId: incident.providerId,
      }),
    );
  }

  if (rows.length === 0) {
    return 0;
  }
  const created = await tx.notificationLog.createMany({ data: rows, skipDuplicates: true });
  return created.count;
}

@Injectable()
export class ServiceIssueOutbox implements OnModuleDestroy, BackgroundWorkOwner {
  private readonly logger = new Logger(ServiceIssueOutbox.name);

  /** The sweep currently running in this process, if any (see ReviewInvitationOutbox). */
  private inFlight: Promise<IntentDeliveryResult> | null = null;

  /** Every `deliverSoon` call not yet finished, queued ones included. */
  private readonly background = new BackgroundRuns();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** Delivers every service-issue notice still owed. Never throws; see `deliverPendingIntents`. */
  async deliverPending(options: { limit?: number } = {}): Promise<IntentDeliveryResult> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }

    const sweep = deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: SERVICE_ISSUE_NOTIFICATION_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Service issue',
    }).finally(() => {
      if (this.inFlight === sweep) {
        this.inFlight = null;
      }
    });
    this.inFlight = sweep;

    return sweep;
  }

  async onModuleDestroy(): Promise<void> {
    await this.whenIdle();
  }

  /** Resolves once no sweep is running or queued in this process. */
  async whenIdle(): Promise<void> {
    while (this.background.busy || this.inFlight) {
      await this.background.whenIdle();
      await this.inFlight?.catch(() => undefined);
    }
  }

  /** Fire after a commit; never awaited by a request handler. */
  deliverSoon(): void {
    this.background.start(() =>
      this.deliverPending().catch((error: unknown) => {
        this.logger.error(
          'Service issue notice delivery failed',
          error instanceof Error ? error.stack : String(error),
        );
      }),
    );
  }
}
