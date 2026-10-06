import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BackgroundRuns, type BackgroundWorkOwner } from '../../common/background-work';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { recipientFor, TransactionalMailService } from './transactional-mail.service';

/**
 * PR #118 — the notices a request cancellation owes, as durable intents.
 *
 * The arrangement of `PackageRefundNotificationOutbox`: the intents are written
 * inside the cancel's own transaction, from the cancellation audit row that
 * transaction just wrote, so a cancel that commits always owes them and one
 * that rolls back owes none. They are sent after the commit by `deliverSoon`,
 * and anything that did not go out is swept by the request lifecycle tick.
 *
 * Dedupe keys are the request (customer) and the offer (providers). A request
 * is cancelled once — the audit row is UNIQUE on it — and a second enqueue of
 * the same key collides on `(template, dedupeKey)` and writes nothing.
 */
export const REQUEST_CANCELLATION_NOTIFICATION_TEMPLATES = [
  'request-cancelled-customer',
  'request-cancelled-winner',
  'request-cancelled-offer',
] as const;

const DEFAULT_DELIVERY_LIMIT = 200;

/**
 * Writes every notice one cancellation owes, inside the caller's transaction.
 * Nothing is sent here. Returns how many intents were written.
 *
 * - the customer, when the request carries an e-mail address;
 * - the provider of the accepted offer, when the request was matched;
 * - every other provider whose offer the cancel closed or refunded.
 */
export async function enqueueRequestCancellationNotices(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<number> {
  const cancellation = await tx.serviceRequestCancellation.findUnique({
    where: { requestId },
    select: {
      acceptedOfferId: true,
      closedOfferIds: true,
      refundedOfferIds: true,
      request: { select: { customerId: true, customerEmail: true } },
    },
  });
  if (!cancellation) {
    return 0;
  }

  const rows: Prisma.NotificationLogCreateManyInput[] = [];
  const customerEmail = cancellation.request.customerEmail?.trim();
  if (customerEmail) {
    rows.push(
      intentRow({
        template: 'request-cancelled-customer',
        to: customerEmail,
        dedupeKey: `request-cancelled-customer:${requestId}`,
        requestId,
        userId: cancellation.request.customerId,
        providerId: null,
      }),
    );
  }

  const offerIds = [
    ...new Set([
      ...(cancellation.acceptedOfferId ? [cancellation.acceptedOfferId] : []),
      ...cancellation.closedOfferIds,
      ...cancellation.refundedOfferIds,
    ]),
  ];
  const offers = offerIds.length
    ? await tx.offer.findMany({
        where: { id: { in: offerIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          providerId: true,
          provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
        },
      })
    : [];

  for (const offer of offers) {
    const recipient = recipientFor(offer.provider);
    if (!recipient) continue;
    const template =
      offer.id === cancellation.acceptedOfferId ? 'request-cancelled-winner' : 'request-cancelled-offer';
    rows.push(
      intentRow({
        template,
        to: recipient,
        dedupeKey: `${template}:${offer.id}`,
        requestId,
        userId: offer.provider.userId,
        providerId: offer.providerId,
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
export class RequestCancellationOutbox implements OnModuleDestroy, BackgroundWorkOwner {
  private readonly logger = new Logger(RequestCancellationOutbox.name);

  /** The sweep currently running in this process, if any (see ReviewInvitationOutbox). */
  private inFlight: Promise<IntentDeliveryResult> | null = null;

  /** Every `deliverSoon` call not yet finished, queued ones included. */
  private readonly background = new BackgroundRuns();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** Delivers every cancellation notice still owed. Never throws; see `deliverPendingIntents`. */
  async deliverPending(options: { limit?: number } = {}): Promise<IntentDeliveryResult> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }

    const sweep = deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: REQUEST_CANCELLATION_NOTIFICATION_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Request cancellation',
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
          'Request cancellation notice delivery failed',
          error instanceof Error ? error.stack : String(error),
        );
      }),
    );
  }
}
