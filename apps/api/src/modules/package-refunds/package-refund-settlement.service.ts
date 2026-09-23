import { Injectable } from '@nestjs/common';
import {
  PackagePurchaseStatus,
  PackageRefundActorKind,
  PackageRefundAuditAction,
  PackageRefundRequestStatus,
  type Prisma,
} from '@prisma/client';
import { touchTicket } from './package-refund-requests.service';

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
 * A purchase with no request waiting for settlement is left exactly as the
 * S3 path left it; nothing is created. A redelivery never reaches this method
 * (the webhook short-circuits a MANUAL_REVIEW_REQUIRED event before its
 * transaction does anything), and if it somehow did, the request is no longer
 * APPROVED_PENDING_SETTLEMENT and the unique indexes on the webhook event would
 * refuse a second settlement anyway.
 */
@Injectable()
export class PackageRefundSettlementService {
  async settleFromWebhook(
    tx: Prisma.TransactionClient,
    input: { purchaseId: string; webhookEventId: string; now: Date },
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

    const swapped = await tx.packageRefundRequest.updateMany({
      where: { id: request.id, status: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT },
      data: {
        status: PackageRefundRequestStatus.SETTLED,
        settledAt: input.now,
        settledByWebhookEventId: input.webhookEventId,
      },
    });
    if (swapped.count !== 1) {
      return null;
    }

    await tx.packageRefundRequestEvent.create({
      data: {
        requestId: request.id,
        action: PackageRefundAuditAction.SETTLED,
        fromStatus: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
        toStatus: PackageRefundRequestStatus.SETTLED,
        actorKind: PackageRefundActorKind.PAYMENT_WEBHOOK,
        actorId: null,
        webhookEventId: input.webhookEventId,
        createdAt: input.now,
      },
    });

    await touchTicket(tx, request.supportTicketId, input.now);

    // S0 §3.5: the first writer of REFUNDED. Guarded on PAID so a purchase
    // somebody already moved is not overwritten.
    await tx.packagePurchase.updateMany({
      where: { id: input.purchaseId, status: PackagePurchaseStatus.PAID },
      data: { status: PackagePurchaseStatus.REFUNDED, refundedAt: input.now },
    });

    return request.id;
  }
}
