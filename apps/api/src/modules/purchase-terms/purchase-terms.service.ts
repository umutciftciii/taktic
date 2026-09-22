import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestMeta } from '../../common/request-meta';
import { resolvePurchaseTermsGate, type ValidatedPurchaseTerms } from './purchase-terms.config';

export const PURCHASE_TERMS_NOT_ACCEPTED = 'PURCHASE_TERMS_NOT_ACCEPTED';
export const PURCHASE_TERMS_VERSION_STALE = 'PURCHASE_TERMS_VERSION_STALE';

/** What a checkout request says about the terms. Both fields are optional on the wire. */
export type PurchaseTermsClaim = {
  termsAccepted?: unknown;
  termsVersion?: unknown;
};

/**
 * The purchase-terms gate and the only writer of `PurchaseTermsAcceptance`.
 *
 * Three entry points, and nothing else touches the table:
 *
 * - {@link describeForCheckout} — what the checkout screen shows. With the
 *   gate closed it says `required: false` and carries no text at all: a draft
 *   is never published by accident.
 * - {@link requireAcceptance} — the request-time check. With the gate closed
 *   it returns null and the caller does exactly what it did before; with it
 *   open, a request that did not tick the box or saw an older version is
 *   refused before any row exists.
 * - {@link recordAcceptance} — the insert, inside the caller's transaction and
 *   before the purchase row (the FK back to the purchase is deferred to
 *   commit). There is no update or delete method, and the database refuses
 *   both anyway.
 *
 * The text stored is always the server's own snapshot. Nothing a client sends
 * — no text, no digest, no time — is written.
 */
@Injectable()
export class PurchaseTermsService implements OnModuleInit {
  /**
   * Boot-time refusal: a deployment that opened the gate with a corrupt,
   * incomplete or (outside local/test) unapproved document set does not start.
   */
  onModuleInit() {
    resolvePurchaseTermsGate();
  }

  /** Read per call, so a test that sets the variable sees the gate it set. */
  private currentTerms(): ValidatedPurchaseTerms | null {
    const gate = resolvePurchaseTermsGate();
    return gate.enabled ? gate.terms : null;
  }

  describeForCheckout() {
    const terms = this.currentTerms();
    if (!terms) {
      return { required: false as const };
    }

    return {
      required: true as const,
      documentKey: terms.documentKey,
      version: terms.version,
      // PENDING is rendered as TASLAK by the web app. It can only be served
      // at all on a local stack or in tests (purchase-terms.config.ts).
      legalReviewStatus: terms.legalReviewStatus,
      documents: terms.documents.map(({ key, title, text }) => ({ key, title, text })),
    };
  }

  /**
   * Null when the gate is closed. Otherwise the terms this purchase will be
   * bound to, after checking that the request ticked the box (a literal
   * `true`, nothing truthy) for exactly the version being served.
   */
  requireAcceptance(claim: PurchaseTermsClaim): ValidatedPurchaseTerms | null {
    const terms = this.currentTerms();
    if (!terms) {
      return null;
    }

    if (claim.termsAccepted !== true) {
      throw new BadRequestException({
        code: PURCHASE_TERMS_NOT_ACCEPTED,
        message: 'Satın alma koşullarını onaylamadan ödeme başlatılamaz.',
      });
    }

    if (claim.termsVersion !== terms.version) {
      throw new BadRequestException({
        code: PURCHASE_TERMS_VERSION_STALE,
        message: 'Satın alma koşulları güncellendi. Lütfen güncel metni okuyup yeniden onaylayın.',
      });
    }

    return terms;
  }

  /**
   * Writes the acceptance for a purchase that does not exist yet — the caller
   * inserts it next, in the same transaction, with this row's id. The
   * database stamps `acceptedAt` itself.
   */
  async recordAcceptance(
    tx: Prisma.TransactionClient,
    input: {
      purchaseId: string;
      userId: string;
      terms: ValidatedPurchaseTerms;
      meta: RequestMeta;
    },
  ): Promise<{ id: string }> {
    return tx.purchaseTermsAcceptance.create({
      data: {
        purchaseId: input.purchaseId,
        userId: input.userId,
        documentKey: input.terms.documentKey,
        documentVersion: input.terms.version,
        documentSha256: input.terms.sha256,
        documentTextSnapshot: input.terms.snapshot,
        clientIp: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
        sourceChannel: input.meta.sourceChannel,
      },
      select: { id: true },
    });
  }
}
