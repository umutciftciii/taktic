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
 *      transaction, whose unique indexes make a redelivered event, a
 *      re-notified order and two concurrent deliveries all collapse into one
 *      credit load.
 *
 * A redirect back from the hosted checkout page reaches none of this. It is a
 * navigation, and it changes nothing.
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
  | 'ORDER_ID_MISSING';

export const MANUAL_REVIEW_REASON = 'PAYMENT_REVERSAL_REPORTED';

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
      // An order that exists but has not settled. Perfectly normal, and it
      // loads nothing.
      return this.record(event, PaymentWebhookEventStatus.IGNORED, null, 'ORDER_NOT_SETTLED');
    }

    return this.loadCredits(event, config.storeId, config.variantsBySlug);
  }

  /**
   * The settlement path.
   *
   * The whole check-and-write sequence runs inside one Serializable
   * transaction, and the audit row is the last statement in it. That ordering
   * is what makes the unique index on (provider, eventKey) an idempotency lock
   * rather than a report: a redelivery that reaches this point rolls the credit
   * load back along with the duplicate audit row.
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
          const mismatch = await this.settle(tx, event, expectedStoreId, variantsBySlug);

          if (mismatch) {
            await writeAudit(tx, event, PaymentWebhookEventStatus.MISMATCHED, null, mismatch);
            this.logger.error(`webhook ${event.eventName} refused: ${mismatch}`);
            return { status: 'mismatched' } as const;
          }

          return { status: 'processed' } as const;
        },
        { label: 'payments.loadCreditsFromWebhook' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Either this exact event was already recorded, or this order already
        // loaded credits onto some purchase. Both mean the work is done.
        this.logger.log(`webhook ${event.eventName} was a redelivery; nothing to do`);
        return { status: 'duplicate' };
      }

      throw error;
    }
  }

  /**
   * Every check, then the two writes. Returns a mismatch code instead of
   * throwing, so the caller can record the refusal in the same transaction.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    event: LemonSqueezyEvent,
    expectedStoreId: string,
    variantsBySlug: ReadonlyMap<string, string>,
  ): Promise<MismatchCode | null> {
    if (!event.testMode) {
      // This build has no live mode. A delivery that says it is a live payment
      // is either a misconfigured store or somebody else's traffic; either way
      // it must not be able to hand out credits here.
      return 'LIVE_MODE_EVENT';
    }

    if (event.storeId !== expectedStoreId) {
      return 'STORE_MISMATCH';
    }

    if (!event.reference) {
      return 'MISSING_REFERENCE';
    }

    if (!event.objectId) {
      return 'ORDER_ID_MISSING';
    }

    const purchase = await tx.packagePurchase.findUnique({
      where: { paymentReference: event.reference },
      include: { package: { select: { slug: true } } },
    });

    if (!purchase) {
      return 'UNKNOWN_REFERENCE';
    }

    if (purchase.paymentProvider !== LEMON_SQUEEZY_PROVIDER_KIND) {
      return 'PROVIDER_MISMATCH';
    }

    if (purchase.status !== PackagePurchaseStatus.PENDING) {
      // Includes the PAID case, which is the ordinary "already handled" shape:
      // the audit row records it and no balance moves.
      return 'PURCHASE_NOT_PENDING';
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
      return 'AMOUNT_MISMATCH';
    }

    if (event.currency !== purchase.currencySnapshot.toUpperCase()) {
      return 'CURRENCY_MISMATCH';
    }

    // Only checked when the payload carried it: the mapping is the allow-list
    // that decides which sandbox variant may stand for which credit package.
    const expectedVariantId = variantsBySlug.get(purchase.package.slug);
    if (event.variantId !== null && event.variantId !== expectedVariantId) {
      return 'VARIANT_MISMATCH';
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
        paidAt: new Date(),
        providerOrderId: event.objectId,
        creditTransactionId: creditTransaction.id,
      },
    });

    await writeAudit(tx, event, PaymentWebhookEventStatus.PROCESSED, purchase.id, null);

    return null;
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
          const purchase = event.reference
            ? await tx.packagePurchase.findUnique({ where: { paymentReference: event.reference } })
            : await tx.packagePurchase.findUnique({ where: { providerOrderId: event.objectId } });

          if (purchase && !purchase.manualReviewAt) {
            await tx.packagePurchase.update({
              where: { id: purchase.id },
              data: { manualReviewReason: MANUAL_REVIEW_REASON, manualReviewAt: new Date() },
            });
          }

          await writeAudit(
            tx,
            event,
            PaymentWebhookEventStatus.MANUAL_REVIEW_REQUIRED,
            purchase?.id ?? null,
            MANUAL_REVIEW_REASON,
          );

          return { status: 'manual_review_required' } as const;
        },
        { label: 'payments.flagPaymentReversal' },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'duplicate' };
      }

      throw error;
    }
  }

  private async record(
    event: LemonSqueezyEvent,
    status: PaymentWebhookEventStatus,
    purchaseId: string | null,
    detail: string | null,
  ): Promise<WebhookOutcome> {
    try {
      await writeAudit(this.prisma, event, status, purchaseId, detail);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'duplicate' };
      }

      throw error;
    }

    return { status: status === PaymentWebhookEventStatus.IGNORED ? 'ignored' : 'mismatched' };
  }
}

type AuditHost = {
  paymentWebhookEvent: {
    create(args: { data: Prisma.PaymentWebhookEventUncheckedCreateInput }): Promise<unknown>;
  };
};

/**
 * The audit row.
 *
 * `eventKey` is the provider's own opaque identity for the event object and
 * `detail` is one of the short codes in this file. Nothing else is stored: no
 * raw payload, no signature, no amount that could be tied to a named person, no
 * buyer detail of any kind.
 */
function writeAudit(
  host: AuditHost,
  event: LemonSqueezyEvent,
  status: PaymentWebhookEventStatus,
  purchaseId: string | null,
  detail: string | null,
) {
  return host.paymentWebhookEvent.create({
    data: {
      provider: LEMON_SQUEEZY_PROVIDER_KIND,
      eventKey: event.eventKey,
      eventName: event.eventName,
      status,
      purchaseId,
      detail,
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
