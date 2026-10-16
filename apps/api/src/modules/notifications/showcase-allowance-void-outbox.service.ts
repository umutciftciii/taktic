import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OfferAllowanceStatus, Prisma } from '@prisma/client';
import { BackgroundRuns, type BackgroundWorkOwner } from '../../common/background-work';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { deliverPendingIntents, IntentDeliveryResult, intentRow } from './notification-intents';
import { recipientFor, TransactionalMailService } from './transactional-mail.service';

/**
 * SHOWCASE-ALLOWANCE-004 — the provider's notice that a vitrin run's remaining
 * free offers were voided, as a durable intent.
 *
 * The arrangement of `PackageRefundNotificationOutbox`: the intent is written
 * *inside* the void's own transaction, so a void that commits always owes its
 * notice and one that rolls back owes none. It is sent after the commit by
 * `deliverSoon`, and anything that did not go out is swept by the request
 * lifecycle tick. A failed send leaves the intent FAILED and the void exactly
 * as it was — the notice never undoes it.
 *
 * Exactly one notice per grant: the dedupe key is the grant
 * (`showcase-allowance-voided:<grantId>`), and a grant is voided at most once
 * (the DB trigger makes VOID final). A replayed enqueue collides on the unique
 * `(template, dedupeKey)` index and writes nothing.
 *
 * The message carries the card, the package and how many free offers were
 * cancelled — never the reason code, never the operator's note, never who did
 * it. A suspicion is not something to put in a provider's inbox.
 */
export const SHOWCASE_ALLOWANCE_VOID_TEMPLATES = ['showcase-allowance-voided'] as const;

const DEFAULT_DELIVERY_LIMIT = 200;

/**
 * Writes the notice one void owes, inside the caller's transaction. Nothing is
 * sent here. Returns how many intents were written (0 for a grant that is not
 * VOID, a provider with no address, or a replay).
 */
export async function enqueueShowcaseAllowanceVoidedNotice(
  tx: Prisma.TransactionClient,
  grantId: string,
): Promise<number> {
  const grant = await tx.offerAllowanceGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      status: true,
      providerId: true,
      provider: { select: { userId: true, email: true, user: { select: { email: true } } } },
    },
  });

  if (!grant || grant.status !== OfferAllowanceStatus.VOID) {
    return 0;
  }

  const recipient = recipientFor(grant.provider);
  if (!recipient) {
    return 0;
  }

  const created = await tx.notificationLog.createMany({
    data: [
      intentRow({
        template: 'showcase-allowance-voided',
        to: recipient,
        dedupeKey: `showcase-allowance-voided:${grant.id}`,
        requestId: null,
        userId: grant.provider.userId,
        providerId: grant.providerId,
      }),
    ],
    skipDuplicates: true,
  });

  return created.count;
}

@Injectable()
export class ShowcaseAllowanceVoidOutbox implements OnModuleDestroy, BackgroundWorkOwner {
  private readonly logger = new Logger(ShowcaseAllowanceVoidOutbox.name);

  /** The sweep currently running in this process, if any (see ReviewInvitationOutbox). */
  private inFlight: Promise<IntentDeliveryResult> | null = null;

  /** Every `deliverSoon` call not yet finished, queued ones included. */
  private readonly background = new BackgroundRuns();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

  /** Delivers every void notice still owed. Never throws; see `deliverPendingIntents`. */
  async deliverPending(options: { limit?: number } = {}): Promise<IntentDeliveryResult> {
    while (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }

    const sweep = deliverPendingIntents({
      prisma: this.prisma,
      dispatcher: this.dispatcher,
      mail: this.mail,
      logger: this.logger,
      templates: SHOWCASE_ALLOWANCE_VOID_TEMPLATES,
      limit: options.limit ?? DEFAULT_DELIVERY_LIMIT,
      label: 'Showcase allowance void',
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
          'Showcase allowance void notice delivery failed',
          error instanceof Error ? error.stack : String(error),
        );
      }),
    );
  }
}
