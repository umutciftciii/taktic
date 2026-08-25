import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PackagePurchaseStatus, Prisma, UserRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  PackagePurchasesService,
  packagePurchaseOmit,
} from '../package-purchases/package-purchases.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import {
  PaymentProviderKind,
  resolvePaymentProviderKind,
  resolveWebAppBaseUrl,
} from './payment-provider.config';
import { CheckoutSessionError, PaymentProviderPort } from './payment-provider.port';
import {
  LEMON_SQUEEZY_REQUIRED_ENV_KEYS,
  missingLemonSqueezyConfigKeys,
} from './lemon-squeezy.config';

/**
 * Opening a checkout for a provider's own credit package purchase.
 *
 * Three rules run this file, and every one of them is about the checkout being
 * an invitation rather than a settlement:
 *
 * 1. The package, its credit amount, its price and its currency are read from
 *    the database. The request body names a package and nothing else.
 * 2. The purchase row exists before the provider is called and stays PENDING
 *    afterwards. Returning from the hosted page changes nothing; only a
 *    signature-verified webhook can move it (see payments-webhook.service.ts).
 * 3. A live checkout for the same pending purchase is handed back rather than
 *    duplicated, so a provider who submits the form twice — or reloads the
 *    redirect — ends up with one purchase and one payment link.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly provider: PaymentProviderPort,
    @Inject(PackagePurchasesService)
    private readonly packagePurchases: PackagePurchasesService,
  ) {}

  /**
   * What the provider-facing screens are allowed to know about the payment
   * configuration: which adapter is wired in, and that it is a test one. No
   * credential, no store id, no endpoint.
   */
  readPaymentMode() {
    return {
      provider: resolvePaymentProviderKind(),
      mode: 'test' as const,
      liveEnabled: false as const,
    };
  }

  /**
   * The same, plus which settings an operator still has to fill in.
   *
   * `missingConfig` is a list of environment variable **names**. There is no
   * code path in this repository that can put one of their values into an API
   * response, a log line or a database row.
   */
  readAdminPaymentConfig() {
    const kind = resolvePaymentProviderKind();
    const missingConfig = kind === 'lemon-squeezy-test' ? missingLemonSqueezyConfigKeys() : [];

    return {
      ...this.readPaymentMode(),
      configurableKeys:
        kind === 'lemon-squeezy-test' ? [...LEMON_SQUEEZY_REQUIRED_ENV_KEYS] : [],
      missingConfig,
      ready: missingConfig.length === 0,
    };
  }

  async createCheckoutSession(providerId: string, user: AuthUser, dto: CreateCheckoutSessionDto) {
    // Stricter than ProviderAccessGuard on purpose. Buying credits is an act of
    // the account that owns the provider, not an administrative one: an admin
    // who needs to move a balance has the audited grant endpoint.
    if (user.role !== UserRole.PROVIDER) {
      throw new ForbiddenException('Only the provider account can start a credit package checkout');
    }

    const kind = resolvePaymentProviderKind();
    const creditPackage = await this.prisma.offerCreditPackage.findFirst({
      where: { id: readPackageId(dto.packageId), isActive: true },
    });

    if (!creditPackage) {
      throw new BadRequestException('Active credit package not found');
    }

    const reusable = await this.findReusableCheckout(providerId, creditPackage.id, kind);
    if (reusable) {
      return this.present(reusable, kind, true);
    }

    // Held locally rather than read back off the row: the purchase projection
    // deliberately drops the token, so this is the only place it exists outside
    // the database column and the provider's checkout metadata.
    const reference = mintReference();
    const purchase = await this.packagePurchases.createProviderPurchase(providerId, dto, {
      provider: kind,
      reference,
    });

    try {
      const session = await this.provider.createCheckoutSession({
        purchaseId: purchase.id,
        reference,
        packageSlug: purchase.package.slug,
        packageName: purchase.packageNameSnapshot,
        creditAmount: purchase.creditAmountSnapshot,
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
        include: purchaseInclude,
        omit: packagePurchaseOmit,
      });

      return this.present(updated, kind, false);
    } catch (error) {
      const failureCode =
        error instanceof CheckoutSessionError ? error.failureCode : 'PROVIDER_UNAVAILABLE';

      // The purchase does not linger as an unpayable PENDING row. FAILED is an
      // existing terminal state the screens already render, and the code is one
      // of a closed set — never a provider response body.
      await this.prisma.packagePurchase.update({
        where: { id: purchase.id },
        data: {
          status: PackagePurchaseStatus.FAILED,
          failedAt: new Date(),
          paymentFailureCode: failureCode,
        },
      });

      this.logger.error(`checkout could not be opened for purchase ${purchase.id}: ${failureCode}`);

      throw new ServiceUnavailableException({
        code: failureCode,
        message: 'Ödeme sayfası şu anda açılamadı. Lütfen birkaç dakika içinde tekrar deneyin.',
      });
    }
  }

  /**
   * A PENDING purchase for the same package whose hosted checkout is still
   * usable.
   *
   * The mock adapter has no hosted page, so `providerCheckoutUrl` is null for
   * every mock purchase and this never matches — which is exactly the historical
   * behaviour, where each submission opened its own purchase.
   */
  private async findReusableCheckout(
    providerId: string,
    packageId: string,
    kind: PaymentProviderKind,
  ) {
    return this.prisma.packagePurchase.findFirst({
      where: {
        providerId,
        packageId,
        status: PackagePurchaseStatus.PENDING,
        paymentProvider: kind,
        providerCheckoutUrl: { not: null },
        OR: [
          { providerCheckoutExpiresAt: null },
          { providerCheckoutExpiresAt: { gt: new Date() } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: purchaseInclude,
      omit: packagePurchaseOmit,
    });
  }

  private present(
    purchase: Prisma.PackagePurchaseGetPayload<{
      include: typeof purchaseInclude;
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
        // Null means "this provider has no hosted page": the web app renders
        // its own clearly-labelled mock checkout instead.
        url: purchase.providerCheckoutUrl,
        expiresAt: purchase.providerCheckoutExpiresAt,
        reused,
      },
    };
  }
}

const purchaseInclude = {
  provider: {
    select: {
      id: true,
      businessName: true,
      contactName: true,
      email: true,
      city: true,
      district: true,
      status: true,
    },
  },
  package: {
    select: {
      id: true,
      name: true,
      slug: true,
      creditAmount: true,
      priceAmount: true,
      currency: true,
      isActive: true,
    },
  },
} satisfies Prisma.PackagePurchaseInclude;

/**
 * The correlation token.
 *
 * 32 bytes of randomness, base64url so it survives a JSON body and a query
 * string unchanged. It is opaque by construction: it says nothing about the
 * provider, the package or the price, so the copy of it that lives in the
 * payment provider's records is not a piece of information about anybody.
 */
function mintReference(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Where the provider's browser lands after the hosted page.
 *
 * The purchase's own screen, which re-reads the canonical status from this API.
 * Nothing in this URL grants anything, and the correlation token deliberately
 * does not appear in it.
 */
function buildReturnUrl(providerId: string, purchaseId: string): string {
  return `${resolveWebAppBaseUrl()}/providers/${providerId}/package-purchases/${purchaseId}?checkout=return`;
}

function readPackageId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException('Package ID is required');
  }

  return value.trim();
}
