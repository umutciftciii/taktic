import { Injectable } from '@nestjs/common';
import {
  PackagePurchaseStatus,
  PackageRefundActorKind,
  PackageRefundAuditAction,
  PackageRefundRequestStatus,
  type Prisma,
} from '@prisma/client';
import { enqueuePackageRefundNotice } from '../notifications/package-refund-notification-outbox.service';
import type { FullRefundFailure } from '../payments/payments-webhook.service';
import { touchTicket } from './package-refund-requests.service';
import { SETTLEABLE_STATUSES } from './package-refund-request.rules';

/**
 * The reason a webhook-recorded failure carries: one fixed sentence for the
 * operator and the audit trail, and the machine code of the clause that did
 * not hold. Never an amount, a currency or a reference from the payload.
 */
export function webhookSettlementFailureReason(failure: FullRefundFailure): string {
  return `Dış iade tutarı paketin tamamıyla uyuşmadı; manuel inceleme gerekli. (${failure})`;
}

/**
 * CMP-006 PR-B — the one writer of SETTLED.
 *
 * Called only from `PaymentsWebhookService.flagForManualReview`, inside its
 * Serializable transaction, after the signature was verified, the event
 * recorded and the CMP-003 promo revoke run — and only for an `order_refunded`
 * event that is *relevant* by the settlement path's own tests (sandbox event,
 * configured store, the very order that paid this purchase).
 *
 * It does exactly four things, all bookkeeping: the request becomes SETTLED
 * naming the webhook event, one audit row is written (actor: the webhook, no
 * person), the ticket's activity mark moves, and the purchase is marked
 * REFUNDED. It writes no ledger row, moves no credit and takes nothing back —
 * clawback is not in this slice, and the credit/promo side of a reversal is
 * the S3 revoke that already ran.
 *
 * It settles a request that is APPROVED_PENDING_SETTLEMENT or — after an
 * earlier refund notice for the same order did not prove a full refund, or
 * an operator recorded that the refund had not happened — SETTLEMENT_FAILED.
 * That second move is the webhook's alone, like the first.
 *
 * A purchase with no such request is left exactly as the S3 path left it;
 * nothing is created. A redelivery of the same refund state never reaches
 * this method (it keys the same `PaymentWebhookEvent` and is short-circuited
 * before the transaction does anything). A later notice after settlement
 * finds the purchase REFUNDED — no longer a relevant reversal — and the
 * unique indexes on the webhook event and on one SETTLED request per purchase
 * would refuse a second settlement anyway.
 */
@Injectable()
export class PackageRefundSettlementService {
  async settleFromWebhook(
    tx: Prisma.TransactionClient,
    input: { purchaseId: string; webhookEventId: string; now: Date },
  ): Promise<string | null> {
    // Approved and waiting, or failed to reconcile earlier (a partial refund,
    // an unproven figure, an operator's record that the refund had not
    // happened): a proven full refund settles either. The one-open-request
    // index means there is at most one such row per purchase.
    const request = await tx.packageRefundRequest.findFirst({
      where: { purchaseId: input.purchaseId, status: { in: [...SETTLEABLE_STATUSES] } },
      select: { id: true, supportTicketId: true, status: true },
    });

    if (!request) {
      return null;
    }

    const swapped = await tx.packageRefundRequest.updateMany({
      where: { id: request.id, status: request.status },
      data: {
        status: PackageRefundRequestStatus.SETTLED,
        settledAt: input.now,
        settledByWebhookEventId: input.webhookEventId,
      },
    });
    if (swapped.count !== 1) {
      return null;
    }

    const audit = await tx.packageRefundRequestEvent.create({
      data: {
        requestId: request.id,
        action: PackageRefundAuditAction.SETTLED,
        fromStatus: request.status,
        toStatus: PackageRefundRequestStatus.SETTLED,
        actorKind: PackageRefundActorKind.PAYMENT_WEBHOOK,
        actorId: null,
        webhookEventId: input.webhookEventId,
        createdAt: input.now,
      },
    });

    await touchTicket(tx, request.supportTicketId, input.now);
    await enqueuePackageRefundNotice(tx, audit.id);

    // S0 §3.5: the first writer of REFUNDED. Guarded on PAID so a purchase
    // somebody already moved is not overwritten.
    await tx.packagePurchase.updateMany({
      where: { id: input.purchaseId, status: PackagePurchaseStatus.PAID },
      data: { status: PackagePurchaseStatus.REFUNDED, refundedAt: input.now },
    });

    return request.id;
  }

  /**
   * The other outcome of a relevant `order_refunded`: it did not prove a full
   * refund of the order (partial, other amount, other currency, missing
   * figure, or a purchase settled before its provider total was stored).
   *
   * An approved request waiting for settlement becomes SETTLEMENT_FAILED,
   * naming this event as its cause, with one audit row, a ticket activity
   * mark and the provider's notice — and nothing else: the purchase stays
   * PAID, no credit or promo moves. Any other request (none, or one not yet
   * approved) is left alone. A redelivery never reaches here (the webhook
   * short-circuits it), and the unique index on the event refuses a second
   * failure by the same event anyway.
   */
  async failFromWebhook(
    tx: Prisma.TransactionClient,
    input: { purchaseId: string; webhookEventId: string; failure: FullRefundFailure; now: Date },
  ): Promise<string | null> {
    const request = await tx.packageRefundRequest.findFirst({
      where: {
        purchaseId: input.purchaseId,
        status: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
      },
      select: { id: true, supportTicketId: true },
    });

    if (!request) {
      return null;
    }

    const reason = webhookSettlementFailureReason(input.failure);
    const swapped = await tx.packageRefundRequest.updateMany({
      where: { id: request.id, status: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT },
      data: {
        status: PackageRefundRequestStatus.SETTLEMENT_FAILED,
        settlementFailedAt: input.now,
        settlementFailedByWebhookEventId: input.webhookEventId,
        settlementFailureReason: reason,
      },
    });
    if (swapped.count !== 1) {
      return null;
    }

    const audit = await tx.packageRefundRequestEvent.create({
      data: {
        requestId: request.id,
        action: PackageRefundAuditAction.SETTLEMENT_FAILED,
        fromStatus: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
        toStatus: PackageRefundRequestStatus.SETTLEMENT_FAILED,
        actorKind: PackageRefundActorKind.PAYMENT_WEBHOOK,
        actorId: null,
        webhookEventId: input.webhookEventId,
        note: reason,
        createdAt: input.now,
      },
    });

    await touchTicket(tx, request.supportTicketId, input.now);
    await enqueuePackageRefundNotice(tx, audit.id);

    return request.id;
  }
}
