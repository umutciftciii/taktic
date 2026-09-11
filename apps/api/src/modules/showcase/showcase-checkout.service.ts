import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PackagePurchaseStatus,
  Prisma,
  ProviderStatus,
  ShowcaseCardStatus,
  ShowcasePlacementStatus,
  UserRole,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { areaCovers, describeArea } from '../../common/provider-service-area-scope';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { packagePurchaseOmit } from '../package-purchases/package-purchases.service';
import {
  resolvePaymentProviderKind,
  resolveWebAppBaseUrl,
  PaymentProviderKind,
} from '../payments/payment-provider.config';
import { CheckoutSessionError, PaymentProviderPort } from '../payments/payment-provider.port';
import { CreateShowcaseCheckoutDto } from './dto/showcase-checkout.dto';
import { assertCategoryStillOpen } from './showcase-publish-preflight';
import { packageAllowsCardKind } from './showcase-placement.service';
import { resolveShowcasePriceTerms } from './showcase.constants';
import { findCurrentPriceTermsAcceptance } from './showcase-price-terms.service';
import {
  showcaseAreaNotCovered,
  showcaseCardAlreadyPlaced,
  showcaseCardNotFound,
  showcaseCardNotPublishable,
  showcasePackageKindMismatch,
  showcasePackageNotFound,
  showcasePriceTermsReacceptRequired,
  showcaseProviderNotApproved,
} from './showcase.errors';

/**
 * Opening a checkout for one vitrin placement.
 *
 * The three rules `payments.service.ts` runs on for credit packages hold here
 * word for word — the package is read from the database, the purchase row exists
 * before the payment provider is called and stays PENDING afterwards, and a live
 * checkout for the same pending purchase is handed back rather than duplicated.
 * What this adds is a set of preflight checks, and the reason they are here
 * rather than at settlement is simple: **this is the last moment at which
 * refusing is free.** After the money moves, a card that turns out to be
 * unpublishable is a refund conversation.
 *
 * ## What is checked before a checkout opens
 *
 * - the provider's own application is APPROVED;
 * - the card belongs to this provider, is APPROVED and has a live version — the
 *   "an operator said yes to this text" gate;
 * - the package sells placements for this card's kind;
 * - the category is still one a card may sit under and still open;
 * - every area the live version claims is still inside the provider's own
 *   service areas;
 * - the card does not already have a live run;
 * - and there is an acceptance of the price-responsibility text **in the
 *   version in force** on file for this card.
 *
 * ## What the terms gate does and does not reach
 *
 * The last check is the only place a bump of `SHOWCASE_PRICE_TERMS_VERSION` is
 * felt. It gates the *next* sale and nothing that has already been paid for: a
 * run bought under superseded terms stays on the air with the same `endAt`, its
 * card stays approved, and no version is re-opened for review. That asymmetry
 * is the product rule — the platform may change what it asks of the next buyer,
 * and may not change the terms of a sale already made.
 *
 * ## What is deliberately *not* checked
 *
 * Whether this provider already publishes on the same shelf. An earlier draft
 * refused a second card in a category and district the provider already
 * occupied, and refused a narrow card when a wider one covered it. Both are
 * gone. A provider may hold "İstanbul geneli" and "İstanbul/Kadıköy" at once,
 * and five cards on one shelf if they want them — every card is bought
 * separately and published separately. The concern that motivated those
 * refusals is real, but it is about one business filling the visitor's screen,
 * and that is a *ranking* problem: the feed's `provider_rank` spreads one
 * provider's cards across successive rounds. Refusing the sale answered it by
 * telling a paying business their second card was worth nothing.
 */
@Injectable()
export class ShowcaseCheckoutService {
  private readonly logger = new Logger('ShowcaseCheckout');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly payments: PaymentProviderPort,
  ) {}

  /**
   * The dry run behind the buying screen's button.
   *
   * Writes nothing and opens nothing. It exists so the screen can say *why* a
   * card cannot be published — rather than offering a button that opens a
   * checkout which then refuses — and it runs the identical checks the checkout
   * does, so the two cannot disagree.
   */
  async checkEligibility(providerId: string, cardId: string, showcasePackageId?: string) {
    const now = new Date();

    try {
      const { card, pkg } = await this.assertPurchasable(
        this.prisma,
        providerId,
        cardId,
        showcasePackageId ?? null,
        now,
      );

      return {
        eligible: true as const,
        code: null,
        message: null,
        card: { id: card.id, kind: card.kind, categoryId: card.categoryId },
        package: pkg ? { id: pkg.id, name: pkg.name, durationDays: pkg.durationDays } : null,
      };
    } catch (error) {
      // A card that is not the caller's own still answers 404, exactly as it
      // does everywhere else in this feature — a dry run must not become a way
      // to probe the id space for other businesses' cards.
      if (isShowcaseCardNotFound(error)) {
        throw error;
      }

      const body = readErrorBody(error);
      if (!body) {
        throw error;
      }

      return {
        eligible: false as const,
        code: body.code,
        message: body.message,
        card: null,
        package: null,
      };
    }
  }

  /**
   * Opens the hosted checkout, or hands back the one that is already open.
   *
   * Stricter than `ProviderAccessGuard` on purpose, and identically to
   * `PaymentsService.createCheckoutSession`: buying is an act of the account
   * that owns the business, not an administrative one. A SUPER_ADMIN supporting
   * a provider can read every one of these screens and can suspend a placement;
   * they cannot spend that business's money.
   */
  async createCheckout(providerId: string, user: AuthUser, dto: CreateShowcaseCheckoutDto) {
    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Only the provider account can start a vitrin checkout');
    }

    const kind = resolvePaymentProviderKind();
    const now = new Date();

    // Held locally and never read back off the row: the purchase projection
    // drops the token, so this is the only place it exists outside the database
    // column and the payment provider's checkout metadata.
    const reference = randomBytes(32).toString('base64url');

    /*
     * Every precondition and the purchase row, in one Serializable transaction.
     *
     * The preflight used to run on the client and the insert followed it; that
     * left the terms check and the row it authorises in two separate reads of
     * the database. Inside one transaction there is no ordering of writes in
     * which a vitrin purchase exists and the acceptance it was sold against
     * does not — and the row records *which* acceptance, so the answer survives
     * the next bump.
     *
     * The payment provider is called after this commits, never inside it: a
     * network round trip holding a Serializable transaction open is how a
     * settlement path acquires a timeout it cannot explain.
     */
    const opened = await runSerializable(
      this.prisma,
      async (tx) => {
        const { card, pkg, acceptance } = await this.assertPurchasable(
          tx,
          providerId,
          dto.cardId,
          dto.showcasePackageId,
          now,
        );

        if (!pkg || !acceptance) {
          throw showcasePackageNotFound();
        }

        const reusable = await this.findReusableCheckout(tx, providerId, pkg.id, card.id, kind);
        if (reusable) {
          return { purchase: reusable, pkg, reused: true as const };
        }

        const created = await tx.packagePurchase.create({
          data: {
            providerId,
            kind: 'SHOWCASE_PACKAGE',
            packageId: null,
            showcasePackageId: pkg.id,
            showcaseCardId: card.id,
            // The version that is live *now*. The record of what the provider was
            // looking at when they paid; the placement pins the version live at
            // settlement, which may be a newer one.
            showcaseCardVersionId: card.liveVersionId,
            durationDaysSnapshot: pkg.durationDays,
            // The terms this sale was made under. Read in this same
            // transaction, so the two facts cannot come apart.
            showcasePriceTermsAcceptanceId: acceptance.id,
            // Zero, and a CHECK constraint agrees: a vitrin purchase sells
            // visibility and may never load an offer-credit balance.
            creditAmountSnapshot: 0,
            priceAmountSnapshot: pkg.priceAmount,
            currencySnapshot: pkg.currency,
            packageNameSnapshot: pkg.name,
            paymentProvider: kind,
            paymentReference: reference,
          },
          include: showcasePurchaseInclude,
          omit: packagePurchaseOmit,
        });

        return { purchase: created, pkg, reused: false as const };
      },
      { label: 'showcase.createCheckout', logger: this.logger },
    );

    if (opened.reused) {
      return present(opened.purchase, kind, true);
    }

    const purchase = opened.purchase;
    const pkg = opened.pkg;

    try {
      const session = await this.payments.createCheckoutSession({
        purchaseId: purchase.id,
        reference,
        packageSlug: pkg.slug,
        packageName: pkg.name,
        productKind: 'showcase-placement',
        creditAmount: 0,
        priceAmount: purchase.priceAmountSnapshot,
        currency: purchase.currencySnapshot,
        returnUrl: buildReturnUrl(providerId, purchase.id),
      });

      const updated = await this.prisma.packagePurchase.update({
        where: { id: purchase.id },
        data: {
          providerCheckoutId: session.providerCheckoutId,
          providerCheckoutUrl: session.url,
          providerCheckoutExpiresAt: session.expiresAt,
        },
        include: showcasePurchaseInclude,
        omit: packagePurchaseOmit,
      });

      return present(updated, kind, false);
    } catch (error) {
      const failureCode =
        error instanceof CheckoutSessionError ? error.failureCode : 'PROVIDER_UNAVAILABLE';

      // The purchase does not linger as an unpayable PENDING row, which matters
      // more here than for credits: a PENDING vitrin purchase for this card
      // would make the reusable-checkout lookup hand the same dead link back
      // every time the provider pressed the button.
      await this.prisma.packagePurchase.update({
        where: { id: purchase.id },
        data: {
          status: PackagePurchaseStatus.FAILED,
          failedAt: new Date(),
          paymentFailureCode: failureCode,
        },
      });

      this.logger.error(
        `vitrin checkout could not be opened for purchase ${purchase.id}: ${failureCode}`,
      );

      throw new ServiceUnavailableException({
        code: failureCode,
        message: 'Ödeme sayfası şu anda açılamadı. Lütfen birkaç dakika içinde tekrar deneyin.',
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Every preflight check, in the order that refuses most cheaply first and
   * discloses least.
   *
   * The card lookup is bound to the provider id, so another business's card is
   * a 404 with the same body as an id that names nothing — the same rule
   * `loadOwnedCard` already applies, for the same reason: a card is an
   * unpublished price list, and walking the id space to learn who is about to
   * advertise what is exactly the disclosure this feature cannot allow.
   */
  private async assertPurchasable(
    db: Prisma.TransactionClient,
    providerId: string,
    cardId: string,
    showcasePackageId: string | null,
    now: Date,
  ) {
    const card = await db.showcaseCard.findFirst({
      where: { id: cardId, providerId },
      select: {
        id: true,
        kind: true,
        status: true,
        categoryId: true,
        liveVersionId: true,
        provider: { select: { id: true, status: true } },
        category: { select: { id: true, kind: true, status: true } },
        liveVersion: {
          select: {
            id: true,
            areas: { select: { city: true, district: true, neighborhood: true } },
          },
        },
      },
    });

    if (!card) {
      throw showcaseCardNotFound();
    }

    if (card.provider.status !== ProviderStatus.APPROVED) {
      throw showcaseProviderNotApproved();
    }

    // The "admin approved" gate, and both halves are needed. An APPROVED status
    // with no live version is a card whose only approval was withdrawn; a live
    // version on a SUSPENDED card is text an operator has since pulled.
    if (
      card.status !== ShowcaseCardStatus.APPROVED ||
      !card.liveVersionId ||
      !card.liveVersion
    ) {
      throw showcaseCardNotPublishable();
    }

    // The same category rule the card was created under, re-asked now. A
    // category the platform has closed since is a shelf the feed will not
    // render, and selling a run onto it would be selling nothing.
    assertCategoryStillOpen(card.category, card.kind);

    // And the same for coverage. A provider who narrowed their service areas
    // after the card was approved must not be able to buy visibility somewhere
    // they no longer work.
    const coverage = await db.providerServiceArea.findMany({
      where: { providerId },
      select: { city: true, district: true, neighborhood: true },
    });

    for (const area of card.liveVersion.areas) {
      if (!coverage.some((owned) => areaCovers(owned, area))) {
        throw showcaseAreaNotCovered(describeArea(area));
      }
    }

    // One card, one live run. Not a cap on how many cards a provider publishes
    // — see the class comment.
    const live = await db.showcasePlacement.findFirst({
      where: {
        cardId: card.id,
        status: {
          in: [
            ShowcasePlacementStatus.PENDING_ACTIVATION,
            ShowcasePlacementStatus.ACTIVE,
            ShowcasePlacementStatus.SUSPENDED,
          ],
        },
      },
      select: { id: true },
    });

    if (live) {
      throw showcaseCardAlreadyPlaced();
    }

    /*
     * The terms in force, and this card's acceptance of them.
     *
     * Last of the card-level checks, and after the ownership check on purpose:
     * a caller who does not own the card has already been answered with the
     * same 404 an unknown id gets, so nothing here can be used to probe.
     *
     * Read through the caller's client, which for the sale itself is the
     * transaction that writes the purchase. `resolveShowcasePriceTerms` refuses
     * to produce a blank version, so a deployment with no terms configured
     * cannot reach the comparison at all — a blank version would otherwise
     * match an equally blank stored one and sell a run on no terms.
     *
     * The acceptance is keyed to the card, not to the business. A provider who
     * accepted the current text for one card has not accepted it for another;
     * the record says what was agreed and about what, and widening the match to
     * the provider would make the card column decorative.
     */
    const terms = resolveShowcasePriceTerms();
    const acceptance = await findCurrentPriceTermsAcceptance(db, card.id, terms.version);

    if (!acceptance) {
      throw showcasePriceTermsReacceptRequired(terms.version);
    }

    if (!showcasePackageId) {
      return { card: { ...card, liveVersionId: card.liveVersionId }, pkg: null, acceptance };
    }

    const pkg = await db.showcasePackage.findFirst({
      where: { id: showcasePackageId, isActive: true },
      select: {
        id: true,
        name: true,
        slug: true,
        priceAmount: true,
        currency: true,
        durationDays: true,
        allowedCardKind: true,
      },
    });

    if (!pkg) {
      throw showcasePackageNotFound();
    }

    if (!packageAllowsCardKind(pkg.allowedCardKind, card.kind)) {
      throw showcasePackageKindMismatch();
    }

    return { card: { ...card, liveVersionId: card.liveVersionId }, pkg, acceptance };
  }

  /**
   * A PENDING vitrin purchase for the same card and package whose hosted
   * checkout is still usable.
   *
   * The card is part of the key, unlike the credit-package version of this
   * lookup: the same package is bought for many different cards, and handing
   * back a checkout opened for a different card would publish the wrong one.
   */
  private findReusableCheckout(
    db: Prisma.TransactionClient,
    providerId: string,
    showcasePackageId: string,
    cardId: string,
    kind: PaymentProviderKind,
  ) {
    return db.packagePurchase.findFirst({
      where: {
        providerId,
        kind: 'SHOWCASE_PACKAGE',
        showcasePackageId,
        showcaseCardId: cardId,
        status: PackagePurchaseStatus.PENDING,
        paymentProvider: kind,
        providerCheckoutUrl: { not: null },
        OR: [
          { providerCheckoutExpiresAt: null },
          { providerCheckoutExpiresAt: { gt: new Date() } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: showcasePurchaseInclude,
      omit: packagePurchaseOmit,
    });
  }
}

const showcasePurchaseInclude = {
  provider: {
    select: { id: true, businessName: true, contactName: true, email: true, status: true },
  },
  showcasePackage: {
    select: {
      id: true,
      name: true,
      slug: true,
      priceAmount: true,
      currency: true,
      durationDays: true,
      allowedCardKind: true,
    },
  },
  showcaseCard: { select: { id: true, kind: true, categoryId: true } },
} satisfies Prisma.PackagePurchaseInclude;

function present(
  purchase: Prisma.PackagePurchaseGetPayload<{
    include: typeof showcasePurchaseInclude;
    omit: typeof packagePurchaseOmit;
  }>,
  kind: PaymentProviderKind,
  reused: boolean,
) {
  return {
    purchase,
    checkout: {
      provider: kind,
      mode: 'test' as const,
      // Null means "this provider has no hosted page": the web application
      // renders its own clearly-labelled mock checkout instead.
      url: purchase.providerCheckoutUrl,
      expiresAt: purchase.providerCheckoutExpiresAt,
      reused,
    },
  };
}

/**
 * Where the provider's browser lands after the hosted page.
 *
 * The purchase's own screen, which re-reads the canonical status from this API.
 * Nothing in this URL grants anything, and the correlation token deliberately
 * does not appear in it.
 */
function buildReturnUrl(providerId: string, purchaseId: string): string {
  return `${resolveWebAppBaseUrl()}/providers/${providerId}/vitrin/odeme/${purchaseId}?checkout=return`;
}

type ShowcaseErrorBody = { code: string; message: string };

function readErrorBody(error: unknown): ShowcaseErrorBody | null {
  if (typeof error !== 'object' || error === null || !('getResponse' in error)) {
    return null;
  }

  const response = (error as { getResponse: () => unknown }).getResponse();
  if (typeof response !== 'object' || response === null) {
    return null;
  }

  const body = response as Partial<ShowcaseErrorBody>;
  return typeof body.code === 'string' && typeof body.message === 'string'
    ? { code: body.code, message: body.message }
    : null;
}

function isShowcaseCardNotFound(error: unknown): boolean {
  return readErrorBody(error)?.code === 'SHOWCASE_CARD_NOT_FOUND';
}
