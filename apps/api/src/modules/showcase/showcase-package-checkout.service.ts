import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PackagePurchaseStatus, Prisma, ProviderStatus, UserRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
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
import { CreateShowcasePackageCheckoutDto } from './dto/showcase-package-checkout.dto';
import { resolveShowcasePriceTerms } from './showcase.constants';
import {
  showcasePackageNotFound,
  showcasePriceTermsReacceptRequired,
  showcaseProviderNotApproved,
} from './showcase.errors';

/**
 * Opening a checkout for one vitrin package — the package-first sale.
 *
 * The three rules `payments.service.ts` runs on for credit packages hold here
 * word for word: the package is read from the database, the purchase row exists
 * before the payment provider is called and stays PENDING afterwards, and a live
 * checkout for the same pending purchase is handed back rather than duplicated.
 *
 * ## What is bought
 *
 * A *right*, not a run. The purchase names a package and the acceptance it was
 * sold under, and nothing else — no card, no version, no area. Settlement turns
 * it into an AVAILABLE `ShowcaseEntitlement`; a card created later reserves
 * that right and spends it when an operator approves the card. Every check the
 * old card-bound sale ran at checkout time (publishability, coverage, the
 * category still being open, one run per card) now runs where the card is,
 * because at this point there is no card to check.
 *
 * ## The terms gate
 *
 * The acceptance is keyed to the business and the version in force. A provider
 * who has agreed to this version buys again without being asked; a provider
 * who has not must agree to *this* version, in this request, and the row is
 * written in the same transaction as the purchase that cites it. A bump of
 * `SHOWCASE_PRICE_TERMS_VERSION` is felt only by the next sale: rights and runs
 * already paid for keep the terms they were sold under.
 */
@Injectable()
export class ShowcasePackageCheckoutService {
  private readonly logger = new Logger('ShowcasePackageCheckout');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly payments: PaymentProviderPort,
  ) {}

  /** The terms in force and whether this business has already agreed to them. */
  async getTerms(providerId: string) {
    const terms = resolveShowcasePriceTerms();
    const acceptance = await this.prisma.showcasePackageTermsAcceptance.findUnique({
      where: { providerId_termsVersion: { providerId, termsVersion: terms.version } },
      select: { acceptedAt: true },
    });

    return {
      version: terms.version,
      text: terms.text,
      accepted: acceptance !== null,
      acceptedAt: acceptance?.acceptedAt.toISOString() ?? null,
    };
  }

  /**
   * Opens the hosted checkout, or hands back the one that is already open.
   *
   * Stricter than `ProviderAccessGuard` on purpose, and identically to
   * `PaymentsService.createCheckoutSession`: buying is an act of the account
   * that owns the business, not an administrative one. A SUPER_ADMIN supporting
   * a provider can read every one of these screens; they cannot spend that
   * business's money, and they cannot consent to terms on its behalf.
   */
  async createCheckout(providerId: string, user: AuthUser, dto: CreateShowcasePackageCheckoutDto) {
    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Only the provider account can start a vitrin checkout');
    }

    const kind = resolvePaymentProviderKind();
    const terms = resolveShowcasePriceTerms();

    // Held locally and never read back off the row: the purchase projection
    // drops the token, so this is the only place it exists outside the database
    // column and the payment provider's checkout metadata.
    const reference = randomBytes(32).toString('base64url');

    /*
     * Every precondition, the acceptance and the purchase row, in one
     * Serializable transaction. There is no ordering of writes in which a vitrin
     * purchase exists and the acceptance it was sold against does not — and the
     * row records *which* acceptance, so the answer survives the next bump.
     *
     * The payment provider is called after this commits, never inside it: a
     * network round trip holding a Serializable transaction open is how a
     * settlement path acquires a timeout it cannot explain.
     */
    const opened = await runSerializable(
      this.prisma,
      async (tx) => {
        const provider = await tx.providerProfile.findUniqueOrThrow({
          where: { id: providerId },
          select: { status: true },
        });
        if (provider.status !== ProviderStatus.APPROVED) {
          throw showcaseProviderNotApproved();
        }

        const pkg = await tx.showcasePackage.findFirst({
          where: { id: dto.showcasePackageId, isActive: true },
          select: {
            id: true,
            name: true,
            slug: true,
            priceAmount: true,
            currency: true,
            durationDays: true,
          },
        });
        if (!pkg) {
          throw showcasePackageNotFound();
        }

        /*
         * The acceptance in force, or a new one. Read/written inside this
         * transaction so a purchase and the acceptance it names cannot come
         * apart. A provider who already agreed to this version is not asked
         * again; a provider who has not must agree to *this* version.
         */
        let acceptance = await tx.showcasePackageTermsAcceptance.findUnique({
          where: { providerId_termsVersion: { providerId, termsVersion: terms.version } },
          select: { id: true },
        });
        if (!acceptance) {
          if (dto.priceTermsAccepted !== true || dto.priceTermsVersion !== terms.version) {
            throw showcasePriceTermsReacceptRequired(terms.version);
          }
          acceptance = await tx.showcasePackageTermsAcceptance.create({
            data: {
              providerId,
              termsVersion: terms.version,
              termsTextSnapshot: terms.text,
              acceptedByUserId: user.id,
            },
            select: { id: true },
          });
        }

        const reusable = await this.findReusableCheckout(tx, providerId, pkg.id, kind);
        if (reusable) {
          return { purchase: reusable, pkg, reused: true as const };
        }

        const created = await tx.packagePurchase.create({
          data: {
            providerId,
            kind: 'SHOWCASE_PACKAGE',
            packageId: null,
            showcasePackageId: pkg.id,
            // Card-less by definition: the card that spends this right does
            // not exist yet.
            showcaseCardId: null,
            showcaseCardVersionId: null,
            showcasePriceTermsAcceptanceId: null,
            // The terms this sale was made under. Read or written in this same
            // transaction, so the two facts cannot come apart.
            showcasePackageTermsAcceptanceId: acceptance.id,
            durationDaysSnapshot: pkg.durationDays,
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
      { label: 'showcase.createPackageCheckout', logger: this.logger },
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

      // The purchase does not linger as an unpayable PENDING row: a PENDING
      // vitrin purchase for this package would make the reusable-checkout
      // lookup hand the same dead link back every time the provider pressed
      // the button.
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
   * A PENDING card-less vitrin purchase for the same package whose checkout is
   * still usable.
   *
   * `showcaseCardId: null` keeps a legacy card-bound purchase — opened before
   * the package-first flow and still pending — from being handed back as if it
   * were a right: settling it would publish a card, not grant one.
   */
  private findReusableCheckout(
    db: Prisma.TransactionClient,
    providerId: string,
    showcasePackageId: string,
    kind: PaymentProviderKind,
  ) {
    return db.packagePurchase.findFirst({
      where: {
        providerId,
        kind: 'SHOWCASE_PACKAGE',
        showcasePackageId,
        showcaseCardId: null,
        status: PackagePurchaseStatus.PENDING,
        paymentProvider: kind,
        // The mock adapter has no hosted URL; its pending purchase is still the
        // one to continue.
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
