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
  OfferPackageType,
  PackagePurchaseStatus,
  PaymentWebhookEventStatus,
  Prisma,
} from '@prisma/client';
import {
  isConcurrentModificationError,
  runSerializable,
} from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { grantEntitlementForPurchase } from '../entitlements/entitlement-grant';
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

/** The purchase a committed settlement produced, or null when there was none. */
type SettledPurchase = string | null;

/**
 * The event whose redelivery has to be counted once the transaction that
 * recognised it has committed, or null when this delivery was not a redelivery
 * of a terminal event.
 */
type RedeliveredEvent = string | null;

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
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
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
   * The whole settling sequence — every business check, the ledger row, the
   * purchase update and the attempt record — runs inside one Serializable
   * transaction. Reading the event's own row first is what makes `PROCESSED`
   * terminal without a constraint violation standing in for the decision: a
   * settled event is answered from its recorded state, and an event that never
   * settled is judged again from the top.
   *
   * What is deliberately *outside* that transaction is everything a delivery
   * does when it settles nothing: the audit count for a redelivery, and the
   * receipt. Neither decides anything, and both used to be able to turn a
   * correctly-handled delivery into a failure — the receipt by throwing, and
   * the count by making N redeliveries of one event contend for one row until
   * the retry budget ran out and the loser was handed a 409.
   *
   * The rule this method keeps, whatever happens underneath it: a delivery is
   * only ever refused when nothing committed says it was handled. Lemon Squeezy
   * answers a non-2xx by redelivering, so a 409 raised over an event that is
   * already `PROCESSED` is not a retry — it is a loop.
   */
  private async loadCredits(
    event: LemonSqueezyEvent,
    expectedStoreId: string,
    variantsBySlug: ReadonlyMap<string, string>,
  ): Promise<WebhookOutcome> {
    let settled: SettledPurchase = null;
    let redelivered: RedeliveredEvent = null;
    let outcome: WebhookOutcome;

    try {
      outcome = await runSerializable(
        this.prisma,
        async (tx) => {
          // Cleared per attempt. A write conflict rolls the whole callback back
          // and replays it, and a note left over from the rolled-back attempt
          // would be a receipt for a settlement that never committed.
          settled = null;
          redelivered = null;

          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.PROCESSED) {
            // Terminal, and deliberately a read-only transaction from here.
            //
            // The attempt still has to be counted, but counting it *here* is
            // what used to make a redelivery storm eat itself: every redelivery
            // of one event updates one row, so N of them arriving together
            // serialize-conflict with each other, burn the retry budget on work
            // that decides nothing, and the loser is handed a 409 for a
            // delivery that was in fact already handled. Nothing about this
            // branch needs Serializable — the row it reads is terminal — so the
            // count is deferred to {@link countRedelivery} after the
            // transaction, where concurrent increments simply queue on the row
            // lock.
            redelivered = existing.id;
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

          // Noted, not sent. The receipt goes out only once this transaction
          // has committed — a settlement that rolls back must leave no message
          // and no audit row behind it.
          settled = purchaseId;

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
        // produce. The winner owns the receipt; this attempt committed nothing
        // and sends nothing.
        return this.reportSettledState(event);
      }

      if (isConcurrentModificationError(error)) {
        // This attempt could not be serialized against its rivals often enough
        // to give up. That is a statement about *this* transaction, not about
        // the event — so the answer is read from what is actually committed,
        // and the 409 travels only if nothing committed says otherwise.
        return this.reportSettledOrRethrow(event, error);
      }

      throw error;
    }

    // Both outside the try, so a failure in either can never be mistaken for
    // the write conflict the catch above is written to interpret.
    await this.countRedelivery(redelivered);
    await this.notifySettled(settled);
    return outcome;
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
      include: { package: { select: { slug: true, type: true } } },
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

    /*
     * What the settlement grants depends on what was sold, and only one of the
     * two ever happens.
     *
     * A ONE_TIME_CREDITS package loads the ledger — the behaviour this method
     * has always had, unchanged down to the reason string. A period package
     * grants an entitlement instead and moves no balance: its
     * `creditAmountSnapshot` is zero by construction, and a zero-credit ledger
     * row would be a transaction in the provider's history that records
     * nothing.
     *
     * Both are written inside the same Serializable transaction as the purchase
     * update and the audit row, so a redelivered event that got past the
     * PROCESSED short-circuit still cannot produce a second period: the unique
     * index on ProviderPackageEntitlement.purchaseId refuses it at the database.
     */
    const isOneTime = purchase.package.type === OfferPackageType.ONE_TIME_CREDITS;

    const creditTransaction = isOneTime
      ? await this.credits.createProviderCreditTransactionInTransaction(tx, {
          providerId: purchase.providerId,
          type: CreditTransactionType.PACKAGE_PURCHASE,
          amount: purchase.creditAmountSnapshot,
          reason: `Test-mode package purchase: ${purchase.packageNameSnapshot}`,
          referenceType: 'PackagePurchase',
          referenceId: purchase.id,
        })
      : null;

    if (!isOneTime) {
      await grantEntitlementForPurchase(tx, {
        providerId: purchase.providerId,
        purchaseId: purchase.id,
        paidAt: now,
        packageId: purchase.packageId,
        priceAmountSnapshot: purchase.priceAmountSnapshot,
        currencySnapshot: purchase.currencySnapshot,
        packageNameSnapshot: purchase.packageNameSnapshot,
        paymentProvider: purchase.paymentProvider,
      });
    }

    await tx.packagePurchase.update({
      where: { id: purchase.id },
      data: {
        status: PackagePurchaseStatus.PAID,
        paidAt: now,
        providerOrderId: event.objectId,
        ...(creditTransaction ? { creditTransactionId: creditTransaction.id } : {}),
      },
    });

    return { mismatch: null, purchaseId: purchase.id };
  }

  /**
   * The receipt, after the settling transaction has committed.
   *
   * It never throws and never affects the outcome reported to the payment
   * provider: the money has already become credit, and a mail transport that
   * is down must not turn a settled delivery into one Lemon Squeezy will retry.
   * TransactionalMailService swallows its own failures and records them on
   * NotificationLog, which is where an operator picks them up.
   *
   * A redelivery of an already-settled event never reaches here — the PROCESSED
   * short-circuit answers it first — and if one somehow did, the unique index
   * on (template, dedupeKey) refuses the second receipt.
   */
  private async notifySettled(purchaseId: SettledPurchase): Promise<void> {
    if (!purchaseId) {
      return;
    }

    await this.mail.sendPackagePurchaseConfirmation(purchaseId);
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
    let redelivered: RedeliveredEvent = null;
    let outcome: WebhookOutcome;

    try {
      outcome = await runSerializable(
        this.prisma,
        async (tx) => {
          redelivered = null;

          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED) {
            // Terminal for the same reason PROCESSED is: a person owns this
            // one now, and re-flagging a purchase somebody is already looking
            // at would only move the timestamp. The attempt is counted after
            // the transaction, for the reason loadCredits gives.
            redelivered = existing.id;
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

      if (isConcurrentModificationError(error)) {
        // The reversal is flagged by whichever delivery committed; this one
        // reports what is actually stored rather than a 409 the provider would
        // answer by redelivering into the same contention.
        return this.reportFlaggedOrRethrow(event, error);
      }

      throw error;
    }

    await this.countRedelivery(redelivered);
    return outcome;
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
    let redelivered: RedeliveredEvent = null;

    try {
      await runSerializable(
        this.prisma,
        async (tx) => {
          redelivered = null;

          const now = new Date();
          const existing = await readEvent(tx, event);

          if (existing?.status === PaymentWebhookEventStatus.PROCESSED) {
            // Deferred out of the transaction for the reason loadCredits gives.
            redelivered = existing.id;
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

      if (isConcurrentModificationError(error)) {
        return this.reportSettledOrRethrow(event, error);
      }

      throw error;
    }

    await this.countRedelivery(redelivered);

    return { status: status === PaymentWebhookEventStatus.IGNORED ? 'ignored' : 'mismatched' };
  }

  /**
   * The audit increment for a redelivery whose outcome was already terminal.
   *
   * Deliberately a plain statement rather than part of a Serializable
   * transaction. It decides nothing — the row it touches is terminal, and its
   * only effect is `attemptCount` and `lastAttemptAt` — so it needs no
   * isolation beyond the row lock PostgreSQL takes for the update itself.
   * Concurrent redeliveries therefore queue instead of aborting each other,
   * which is what makes both the answer and the count deterministic however
   * many copies of one delivery arrive at once.
   *
   * Best-effort, like the receipt below and for the same reason: the delivery
   * has already been answered correctly from committed state, and a failure to
   * bump a counter must not turn it into one the provider will retry.
   */
  private async countRedelivery(eventId: RedeliveredEvent): Promise<void> {
    if (!eventId) {
      return;
    }

    try {
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventId },
        data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `failed to count a webhook redelivery on event ${eventId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The answer for a delivery whose own transaction could not be serialized,
   * decided by what is actually committed.
   *
   * The distinction from {@link reportSettledState} is the fallback, and it is
   * the whole point of having two methods. A unique violation proves somebody
   * else committed, so reading their record is the answer. An exhausted retry
   * budget proves nothing about anybody: if the committed state does not say
   * this event settled, then as far as this application knows it did not, and
   * the 409 is rethrown so the provider redelivers. Answering `duplicate` there
   * would tell a payment provider that a payment was handled on the strength of
   * this process having failed to commit — which is how a paid order silently
   * loads no credits.
   */
  private async reportSettledOrRethrow(
    event: LemonSqueezyEvent,
    error: unknown,
  ): Promise<WebhookOutcome> {
    const stored = await readEvent(this.prisma, event);

    if (stored?.status !== PaymentWebhookEventStatus.PROCESSED) {
      this.logger.error(
        `webhook ${event.eventName} could not be committed and is not settled; asking for a redelivery`,
      );
      throw error;
    }

    this.logger.log(
      `webhook ${event.eventName} could not be committed, but a concurrent delivery had already settled it`,
    );
    await this.countRedelivery(stored.id);
    return { status: 'duplicate' };
  }

  /** The same, for the reversal path's own terminal status. */
  private async reportFlaggedOrRethrow(
    event: LemonSqueezyEvent,
    error: unknown,
  ): Promise<WebhookOutcome> {
    const stored = await readEvent(this.prisma, event);

    if (stored?.status !== PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED) {
      this.logger.error(
        `webhook ${event.eventName} could not be committed and is not flagged; asking for a redelivery`,
      );
      throw error;
    }

    await this.countRedelivery(stored.id);
    return { status: 'manual_review_required' };
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

    // A delivery answered from a stored row is still a delivery of that event,
    // and the audit trail says every one of them is counted — see the
    // `attemptCount` assertions in lemon-squeezy-webhook.spec.ts. It used not
    // to be counted here, which left the figure dependent on *which* way a
    // redelivery happened to lose its race: the same six deliveries could
    // report six attempts or four.
    if (stored) {
      await this.countRedelivery(stored.id);
    }

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
