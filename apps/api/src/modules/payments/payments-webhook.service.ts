import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  Prisma,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { LEMON_SQUEEZY_PROVIDER_KIND, readLemonSqueezyConfig } from './lemon-squeezy.config';
import {
  LEMON_SQUEEZY_PAYMENT_EVENTS,
  LEMON_SQUEEZY_REVERSAL_EVENTS,
  LEMON_SQUEEZY_SETTLED_ORDER_STATUSES,
  LemonSqueezyEvent,
  readLemonSqueezyEvent,
  verifyLemonSqueezySignature,
} from './lemon-squeezy.webhook';
import { resolvePaymentProviderKind } from './payment-provider.config';

/**
 * The only path in this application that may load credits from a payment.
 *
 * Everything about it is ordered so that nothing happens before the delivery is
 * proven to come from the configured store:
 *
 *   1. The endpoint does not exist unless this process is wired to the sandbox
 *      provider.
 *   2. The raw bytes are HMAC-verified. A failure is a 401 and zero database
 *      writes — the bytes are not parsed, not stored and not logged.
 *   3. Only then is the payload read, and only into the narrow projection in
 *      lemon-squeezy.webhook.ts, which drops every buyer detail the payload
 *      carries.
 *   4. The event's own facts are matched against this application's records —
 *      test mode, store, correlation token, amount, currency, variant, and the
 *      purchase's own state. A single mismatch loads nothing and leaves an
 *      audit row.
 *   5. The effect and its audit row are written in one Serializable
 *      transaction.
 *
 * A redirect back from the hosted checkout page reaches none of this. It is a
 * navigation, and it changes nothing.
 *
 * ## Why a refused delivery must stay recoverable
 *
 * A provider re-sends an event whose first delivery did not settle, and that is
 * the intended way to recover from a refusal this application caused: a variant
 * mapped wrongly, a package repriced mid-checkout, a comparison reading the
 * wrong field. Recovery only works if the second delivery is judged on its own
 * merits.
 *
 * So `PaymentWebhookEvent` holds one row per event rather than one per
 * delivery, and only `PROCESSED` is terminal:
 *
 * - `PROCESSED` — the money already became credit. A later delivery counts the
 *   attempt and moves nothing: not the purchase, not the ledger, not the
 *   balance.
 * - `MISMATCHED` and `IGNORED` — refusals with no financial effect. A later
 *   delivery re-runs every check from the signature down, and settles if they
 *   now pass.
 *
 * The row keeps what a re-evaluation would otherwise erase: when the event was
 * first seen, how many deliveries it took, what the first refusal was, and when
 * it finally resolved.
 *
 * Two deliveries of one event arriving at once, or two events naming one
 * provider order, still load credits exactly once — that is the job of the
 * Serializable transaction, the `PROCESSED` short-circuit inside it and the
 * unique index on `providerOrderId`, all three of which survive this.
 */
export type WebhookOutcome = {
  status: 'processed' | 'duplicate' | 'ignored' | 'mismatched' | 'manual_review_required';
};

/** What a mismatch was, as a short machine code. Never a payload fragment. */
type MismatchCode =
  | 'LIVE_MODE_EVENT'
  | 'STORE_MISMATCH'
  | 'MISSING_REFERENCE'
  | 'UNKNOWN_REFERENCE'
  | 'PROVIDER_MISMATCH'
  | 'PURCHASE_NOT_PENDING'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'VARIANT_MISMATCH'
  | 'ORDER_ID_MISSING'
  | 'ORDER_ALREADY_SETTLED';

export const MANUAL_REVIEW_REASON = 'PAYMENT_REVERSAL_REPORTED';

/**
 * Outcomes a later delivery of the same event may overturn.
 *
 * Both are refusals that moved no money, so re-judging one costs nothing and
 * is the only way a corrected deployment can settle an order it already
 * refused. Every other status is left alone: `PROCESSED` because the credit
 * exists, `MANUAL_REVIEW_REQUIRED` because a person owns it.
 */
const RECOVERABLE_STATUSES: ReadonlySet<PaymentWebhookEventStatus> = new Set([
  PaymentWebhookEventStatus.IGNORED,
  PaymentWebhookEventStatus.MISMATCHED,
]);

type SettlementResult = {
  mismatch: MismatchCode | null;
  /** Known as soon as the correlation token resolves, mismatch or not. */
  purchaseId: string | null;
};

type AttemptOutcome = {
  status: PaymentWebhookEventStatus;
  purchaseId: string | null;
  detail: string | null;
};

/** The columns an attempt needs from the row it is updating. */
type ExistingEvent = {
  id: string;
  status: PaymentWebhookEventStatus;
  firstFailureCode: string | null;
  firstFailureAt: Date | null;
};

@Injectable()
export class PaymentsWebhookService {
  private readonly logger = new Logger('PaymentsWebhook');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CreditsService) private readonly credits: CreditsService,
  ) {}

  async handleLemonSqueezyDelivery(
    rawBody: Buffer | undefined,
    signatureHeader: unknown,
  ): Promise<WebhookOutcome> {
    if (resolvePaymentProviderKind() !== LEMON_SQUEEZY_PROVIDER_KIND) {
      // Not "forbidden": a deployment that is not wired to this provider has no
      // such endpoint, and saying so would confirm the URL exists elsewhere.
      throw new NotFoundException();
    }

    const config = readLemonSqueezyConfig();

    if (!verifyLemonSqueezySignature(rawBody, signatureHeader, config.webhookSecret)) {
      // Nothing has been parsed and nothing is written. The rejection is counted
      // in the application log without the body, the header or the secret.
      this.logger.warn('rejected a webhook delivery with an invalid or missing signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = readLemonSqueezyEvent(rawBody as Buffer);
    if (!event) {
      throw new BadRequestException('Unreadable webhook payload');
    }

    if (LEMON_SQUEEZY_REVERSAL_EVENTS.has(event.eventName)) {
      return this.flagForManualReview(event);
    }

    if (!LEMON_SQUEEZY_PAYMENT_EVENTS.has(event.eventName)) {
      return this.record(event, PaymentWebhookEventStatus.IGNORED, null, 'UNHANDLED_EVENT');
    }

    if (!LEMON_SQUEEZY_SETTLED_ORDER_STATUSES.has(event.orderStatus ?? '')) {
      // An order that exists but has not settled. Perfectly normal, it loads
      // nothing, and it stays open to a later delivery that says otherwise.
      return this.record(event, PaymentWebhookEventStatus.IGNORED, null, 'ORDER_NOT_SETTLED');
    }

    return this.loadCredits(event, config.storeId, config.variantsBySlug);
  }

  /**
   * The settlement path.
   *
   * The whole sequence — the terminal check, every business check, the ledger
   * row, the purchase update and the attempt record — runs inside one
   * Serializable transaction. Reading the event's own row first is what makes
   * `PROCESSED` terminal without a constraint violation standing in for the
   * decision: a settled event is answered from its recorded state, and an event
   * that never settled is judged again from the top.
   */
  private async loadCredits(
    event: LemonSqueezyEvent,
    expectedStoreId: string,
    variantsBySlug: ReadonlyMap<string, string>,
  ): Promise<WebhookOutcome> {
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.PROCESSED) {
            // Terminal. The delivery is counted so the audit trail shows the
            // provider retried, and not one other field moves.
            await countAttempt(tx, existing.id, now);
            this.logger.log(
              `webhook ${event.eventName} was redelivered after settling; nothing to do`,
            );
            return { status: 'duplicate' } as const;
          }

          const { mismatch, purchaseId } = await this.settle(
            tx,
            event,
            expectedStoreId,
            variantsBySlug,
            now,
          );

          if (mismatch) {
            await recordAttempt(
              tx,
              event,
              existing,
              { status: PaymentWebhookEventStatus.MISMATCHED, purchaseId, detail: mismatch },
              now,
            );
            this.logger.error(`webhook ${event.eventName} refused: ${mismatch}`);
            return { status: 'mismatched' } as const;
          }

          await recordAttempt(
            tx,
            event,
            existing,
            { status: PaymentWebhookEventStatus.PROCESSED, purchaseId, detail: null },
            now,
          );

          if (existing) {
            this.logger.log(
              `webhook ${event.eventName} settled on a later delivery after ` +
                `${existing.firstFailureCode ?? 'an earlier refusal'}`,
            );
          }

          return { status: 'processed' } as const;
        },
        { label: 'payments.loadCreditsFromWebhook' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two deliveries of this event, or two events naming one provider
        // order, reached the write together and this one lost. It reports the
        // state that actually exists rather than claiming an outcome it did not
        // produce.
        return this.reportSettledState(event);
      }

      throw error;
    }
  }

  /**
   * Every check, then the two writes. Returns a mismatch code instead of
   * throwing, so the caller can record the refusal in the same transaction,
   * and returns the purchase it resolved so a refusal is auditable against the
   * purchase it refused.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    event: LemonSqueezyEvent,
    expectedStoreId: string,
    variantsBySlug: ReadonlyMap<string, string>,
    now: Date,
  ): Promise<SettlementResult> {
    if (!event.testMode) {
      // This build has no live mode. A delivery that says it is a live payment
      // is either a misconfigured store or somebody else's traffic; either way
      // it must not be able to hand out credits here.
      return { mismatch: 'LIVE_MODE_EVENT', purchaseId: null };
    }

    if (event.storeId !== expectedStoreId) {
      return { mismatch: 'STORE_MISMATCH', purchaseId: null };
    }

    if (!event.reference) {
      return { mismatch: 'MISSING_REFERENCE', purchaseId: null };
    }

    if (!event.objectId) {
      return { mismatch: 'ORDER_ID_MISSING', purchaseId: null };
    }

    const purchase = await tx.packagePurchase.findUnique({
      where: { paymentReference: event.reference },
      include: { package: { select: { slug: true } } },
    });

    if (!purchase) {
      return { mismatch: 'UNKNOWN_REFERENCE', purchaseId: null };
    }

    if (purchase.paymentProvider !== LEMON_SQUEEZY_PROVIDER_KIND) {
      return { mismatch: 'PROVIDER_MISMATCH', purchaseId: purchase.id };
    }

    if (purchase.status !== PackagePurchaseStatus.PENDING) {
      // Includes the PAID case, which is the ordinary "already handled" shape:
      // the audit row records it and no balance moves.
      return { mismatch: 'PURCHASE_NOT_PENDING', purchaseId: purchase.id };
    }

    // Compared against the purchase's own snapshot, not against the package
    // row: a package repriced after the checkout was opened must not change
    // what this order is allowed to settle.
    //
    // The event side of the comparison is the order line item's price times its
    // quantity, not the order total — see chargedMinor in lemon-squeezy.webhook.ts.
    // The equality is exact and stays exact: a tolerance here would be a hole in
    // the one check that ties a settlement notice to an amount this application
    // chose.
    if (event.chargedMinor !== purchase.priceAmountSnapshot) {
      return { mismatch: 'AMOUNT_MISMATCH', purchaseId: purchase.id };
    }

    if (event.currency !== purchase.currencySnapshot.toUpperCase()) {
      return { mismatch: 'CURRENCY_MISMATCH', purchaseId: purchase.id };
    }

    // Only checked when the payload carried it: the mapping is the allow-list
    // that decides which sandbox variant may stand for which credit package.
    const expectedVariantId = variantsBySlug.get(purchase.package.slug);
    if (event.variantId !== null && event.variantId !== expectedVariantId) {
      return { mismatch: 'VARIANT_MISMATCH', purchaseId: purchase.id };
    }

    // One provider order settles one purchase. The unique index on
    // providerOrderId enforces it; reading first turns the enforcement into a
    // recorded refusal instead of a constraint violation that would roll the
    // attempt record back with it.
    const orderOwner = await tx.packagePurchase.findUnique({
      where: { providerOrderId: event.objectId },
      select: { id: true },
    });

    if (orderOwner && orderOwner.id !== purchase.id) {
      return { mismatch: 'ORDER_ALREADY_SETTLED', purchaseId: purchase.id };
    }

    const creditTransaction = await this.credits.createProviderCreditTransactionInTransaction(tx, {
      providerId: purchase.providerId,
      type: CreditTransactionType.PACKAGE_PURCHASE,
      amount: purchase.creditAmountSnapshot,
      reason: `Test-mode package purchase: ${purchase.packageNameSnapshot}`,
      referenceType: 'PackagePurchase',
      referenceId: purchase.id,
    });

    await tx.packagePurchase.update({
      where: { id: purchase.id },
      data: {
        status: PackagePurchaseStatus.PAID,
        paidAt: now,
        providerOrderId: event.objectId,
        creditTransactionId: creditTransaction.id,
      },
    });

    return { mismatch: null, purchaseId: purchase.id };
  }

  /**
   * Refunds and chargebacks.
   *
   * They set a flag and nothing else. Deducting credits automatically would
   * mean taking back capacity a provider may already have spent on offers that
   * were sent and answered, and this phase deliberately leaves that decision to
   * a person looking at the audit trail.
   */
  private async flagForManualReview(event: LemonSqueezyEvent): Promise<WebhookOutcome> {
    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED) {
            // Terminal for the same reason PROCESSED is: a person owns this
            // one now, and re-flagging a purchase somebody is already looking
            // at would only move the timestamp.
            await countAttempt(tx, existing.id, now);
            return { status: 'duplicate' } as const;
          }

          const purchase = event.reference
            ? await tx.packagePurchase.findUnique({ where: { paymentReference: event.reference } })
            : await tx.packagePurchase.findUnique({ where: { providerOrderId: event.objectId } });

          if (purchase && !purchase.manualReviewAt) {
            await tx.packagePurchase.update({
              where: { id: purchase.id },
              data: { manualReviewReason: MANUAL_REVIEW_REASON, manualReviewAt: now },
            });
          }

          await recordAttempt(
            tx,
            event,
            existing,
            {
              status: PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED,
              purchaseId: purchase?.id ?? null,
              detail: MANUAL_REVIEW_REASON,
            },
            now,
          );

          return { status: 'manual_review_required' } as const;
        },
        { label: 'payments.flagPaymentReversal' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'manual_review_required' };
      }

      throw error;
    }
  }

  /**
   * An outcome with no financial effect: an event this integration does not
   * act on, or an order that has not settled yet.
   *
   * Recorded the same way as a refusal, and just as re-judgeable — an order
   * that was not settled when it first arrived may well be settled by the time
   * the provider sends it again.
   */
  private async record(
    event: LemonSqueezyEvent,
    status: PaymentWebhookEventStatus,
    purchaseId: string | null,
    detail: string | null,
  ): Promise<WebhookOutcome> {
    try {
      await runSerializable(
        this.prisma,
        async (tx) => {
          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.PROCESSED) {
            await countAttempt(tx, existing.id, now);
            return;
          }

          await recordAttempt(tx, event, existing, { status, purchaseId, detail }, now);
        },
        { label: 'payments.recordWebhookAttempt' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.reportSettledState(event);
      }

      throw error;
    }

    return { status: status === PaymentWebhookEventStatus.IGNORED ? 'ignored' : 'mismatched' };
  }

  /**
   * The answer for a delivery that lost a race, read from what the winner
   * actually recorded.
   *
   * Reporting the stored state rather than assuming "duplicate means settled"
   * is the point: a delivery must never be told its order was handled when the
   * concurrent attempt refused it.
   */
  private async reportSettledState(event: LemonSqueezyEvent): Promise<WebhookOutcome> {
    const stored = await readEvent(this.prisma, event);

    if (stored?.status === PaymentWebhookEventStatus.PROCESSED) {
      this.logger.log(`webhook ${event.eventName} was already settled by a concurrent delivery`);
      return { status: 'duplicate' };
    }

    this.logger.warn(`webhook ${event.eventName} lost a race and was not settled`);
    return { status: 'mismatched' };
  }
}

/**
 * The one table this file reads before it decides anything. Narrowed to that
 * table so both a transaction client and the Prisma service satisfy it.
 */
type EventReader = Pick<Prisma.TransactionClient, 'paymentWebhookEvent'>;

function readEvent(host: EventReader, event: LemonSqueezyEvent): Promise<ExistingEvent | null> {
  return host.paymentWebhookEvent.findUnique({
    where: {
      provider_eventKey: { provider: LEMON_SQUEEZY_PROVIDER_KIND, eventKey: event.eventKey },
    },
    select: { id: true, status: true, firstFailureCode: true, firstFailureAt: true },
  });
}

/** A redelivery of an event whose outcome is not up for re-judgement. */
function countAttempt(tx: Prisma.TransactionClient, id: string, now: Date) {
  return tx.paymentWebhookEvent.update({
    where: { id },
    data: { attemptCount: { increment: 1 }, lastAttemptAt: now },
  });
}

/**
 * The attempt record.
 *
 * One row per event, carrying the latest outcome and the history that outcome
 * would otherwise erase. Written as an upsert rather than an insert: the first
 * delivery creates the row, and every later one updates it — which is the whole
 * reason a refused event can be settled by a redelivery instead of colliding
 * with the record of its own refusal.
 *
 * `firstFailureCode` and `firstFailureAt` are set once and never rewritten, so
 * an event that settled on its third delivery still says what stopped the
 * first. Nothing else is stored: no raw payload, no signature, no amount that
 * could be tied to a named person, no buyer detail of any kind.
 */
function recordAttempt(
  tx: Prisma.TransactionClient,
  event: LemonSqueezyEvent,
  existing: ExistingEvent | null,
  outcome: AttemptOutcome,
  now: Date,
) {
  const failed = RECOVERABLE_STATUSES.has(outcome.status) && outcome.detail !== null;
  const firstFailureCode = existing?.firstFailureCode ?? (failed ? outcome.detail : null);
  const firstFailureAt = existing?.firstFailureAt ?? (failed ? now : null);
  const resolved =
    outcome.status === PaymentWebhookEventStatus.PROCESSED ? { resolvedAt: now } : {};

  return tx.paymentWebhookEvent.upsert({
    where: {
      provider_eventKey: { provider: LEMON_SQUEEZY_PROVIDER_KIND, eventKey: event.eventKey },
    },
    create: {
      provider: LEMON_SQUEEZY_PROVIDER_KIND,
      eventKey: event.eventKey,
      eventName: event.eventName,
      status: outcome.status,
      purchaseId: outcome.purchaseId,
      detail: outcome.detail,
      attemptCount: 1,
      lastAttemptAt: now,
      firstFailureCode,
      firstFailureAt,
      ...resolved,
    },
    update: {
      eventName: event.eventName,
      status: outcome.status,
      // A refusal that could not resolve the purchase must not erase the link a
      // previous attempt established.
      ...(outcome.purchaseId ? { purchaseId: outcome.purchaseId } : {}),
      detail: outcome.detail,
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
      firstFailureCode,
      firstFailureAt,
      ...resolved,
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }

  // Prisma errors can cross module-instance boundaries where `instanceof`
  // fails, so fall back to the error code itself.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
