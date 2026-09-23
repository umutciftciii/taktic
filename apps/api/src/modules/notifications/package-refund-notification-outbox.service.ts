import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import {
  PACKAGE_REFUND_NOTIFIED_STATUSES,
  recipientFor,
  TransactionalMailService,
} from './transactional-mail.service';

/**
 * CMP-006 PR-B — the provider's package refund status notices, as durable
 * intents.
 *
 * The arrangement of `ReviewInvitationOutbox`: the intent is written *inside*
 * the transaction that moves the request (the refund service's transitions,
 * or the webhook's settlement/failure), so a transition that commits always
 * owes its notice and one that rolls back owes none. It is sent after the
 * commit by `deliverSoon`, and anything that did not go out is swept by the
 * request lifecycle tick. A failed send leaves the intent FAILED and the
 * state exactly as it was — the notice never undoes the transition.
 *
 * One intent per transition: the dedupe key is the transition's own audit row
 * (`package-refund-status:<eventId>`). A replayed webhook writes no audit row
 * and so no intent; a second enqueue of the same row collides on the unique
 * `(template, dedupeKey)` index and writes nothing.
 *
 * The provider's withdrawal is not notified — they did it themselves.
 */
export const PACKAGE_REFUND_NOTIFICATION_TEMPLATES = ['package-refund-status'] as const;

const DEFAULT_DELIVERY_LIMIT = 200;

/**
 * Writes the notice one refund transition owes, inside the caller's
 * transaction. Nothing is sent here. Returns how many intents were written
 * (0 for a withdrawal, a provider with no address, or a replay).
 */
export async function enqueuePackageRefundNotice(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<number> {
  const event = await tx.packageRefundRequestEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      toStatus: true,
      request: {
        select: {
          providerId: true,
          provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
        },
      },
    },
  });

  if (!event || !PACKAGE_REFUND_NOTIFIED_STATUSES.has(event.toStatus)) {
    return 0;
  }

  const recipient = recipientFor(event.request.provider);
  if (!recipient) {
    return 0;
  }

  const created = await tx.notificationLog.createMany({
    data: [
      intentRow({
        template: 'package-refund-status',
        to: recipient,
        dedupeKey: `package-refund-status:${event.id}`,
        requestId: null,
        userId: event.request.provider.userId,
        providerId: event.request.providerId,
      }),
    ],
    skipDuplicates: true,
  });

  return created.count;
}

@Injectable()
export class PackageRefundNotificationOutbox implements OnModuleDestroy {
  private readonly logger = new Logger(PackageRefundNotificationOutbox.name);

  /** The sweep currently running in this process, if any (see ReviewInvitationOutbox). */
  private inFlight: Promise<IntentDeliveryResult> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** Delivers every refund notice still owed. Never throws; see `deliverPendingIntents`. */
  async deliverPending(options: { limit?: number } = {}): Promise<IntentDeliveryResult> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }

    const sweep = deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: PACKAGE_REFUND_NOTIFICATION_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Package refund',
    }).finally(() => {
      if (this.inFlight === sweep) {
        this.inFlight = null;
      }
    });
    this.inFlight = sweep;

    return sweep;
  }

  async onModuleDestroy(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Fire after a commit; never awaited by a request handler or a webhook. */
  deliverSoon(): void {
    void this.deliverPending().catch((error: unknown) => {
      this.logger.error(
        'Package refund notice delivery failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }
}
