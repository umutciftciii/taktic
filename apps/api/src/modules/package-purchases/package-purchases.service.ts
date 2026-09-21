import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  CreditTransactionType,
  NumberedEntityType,
  OfferPackageType,
  PackagePurchaseKind,
  PackagePurchaseStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertPackageIsPurchasable,
  grantEntitlementForPurchase,
} from '../entitlements/entitlement-grant';
import { resolvePaymentProviderKind } from '../payments/payment-provider.config';
import { CampaignEngineHooks } from '../campaigns/engine/campaign-engine.hooks';
import { CreditsService } from '../credits/credits.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { NumberingService } from '../numbering/numbering.service';
import { ShowcaseEntitlementService } from '../showcase/showcase-entitlement.service';
import { ShowcasePlacementService } from '../showcase/showcase-placement.service';
import { CreatePackagePurchaseDto } from './dto/create-package-purchase.dto';
import { MockPackagePaymentDto } from './dto/mock-package-payment.dto';
import { UpdatePackagePurchaseStatusDto } from './dto/update-package-purchase-status.dto';

type AdminPurchaseFilters = {
  status?: PackagePurchaseStatus;
  providerId?: string;
  packageId?: string;
};

@Injectable()
export class PackagePurchasesService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CreditsService) private readonly creditsService: CreditsService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(ShowcasePlacementService) private readonly placements: ShowcasePlacementService,
    @Inject(ShowcaseEntitlementService)
    private readonly entitlements: ShowcaseEntitlementService,
    @Inject(CampaignEngineHooks) private readonly campaignHooks: CampaignEngineHooks,
  ) {}

  /** The mock settlement path mirrors the webhook's and raises the same campaign event (CMP-002 S2B2). */
  onModuleInit() {
    this.campaignHooks.registerFactWriter('PACKAGE_PAYMENT_SUCCEEDED', {
      module: 'package-purchases-mock',
      role: UserRole.PROVIDER,
    });
  }

  /**
   * Opens a PENDING purchase against an active credit package.
   *
   * The package is always resolved server-side and its credit amount, price and
   * currency are snapshotted onto the row: a client says which package it
   * wants and nothing about what that package costs or is worth.
   *
   * `payment` is supplied only by the checkout flow (payments.service.ts), which
   * needs the provider kind and its own correlation token written in the same
   * statement that creates the row — a purchase that briefly exists without a
   * reference is a purchase a webhook could not match. Callers that omit it get
   * exactly the behaviour this method has always had.
   */
  async createProviderPurchase(
    providerId: string,
    dto: CreatePackagePurchaseDto,
    payment?: { provider: string; reference: string },
  ) {
    await this.ensureProviderExists(providerId);
    const creditPackage = await this.prisma.offerCreditPackage.findFirst({
      where: { id: normalizeRequiredString(dto.packageId, 'Package ID'), isActive: true },
    });

    if (!creditPackage) {
      throw new BadRequestException('Active credit package not found');
    }

    return this.prisma.$transaction(async (tx) => {
      // Refuses a period package the provider is not in a position to buy —
      // a second queued period, or an unlimited scope another live package of
      // theirs already covers. Checked before the purchase row exists, because
      // this is the last point at which refusing is free. A ONE_TIME_CREDITS
      // package passes straight through, exactly as before.
      await assertPackageIsPurchasable(tx, {
        providerId,
        pkg: creditPackage,
        now: new Date(),
      });

      const purchaseNumber = await this.numbering.generateDisplayNumber(
        tx,
        NumberedEntityType.PACKAGE_PURCHASE,
      );

      return tx.packagePurchase.create({
        data: {
          providerId,
          packageId: creditPackage.id,
          purchaseNumber,
          creditAmountSnapshot: creditPackage.creditAmount,
          priceAmountSnapshot: creditPackage.priceAmount,
          currencySnapshot: creditPackage.currency,
          packageNameSnapshot: creditPackage.name,
          providerNote: normalizeNullableString(dto.providerNote),
          ...(payment
            ? { paymentProvider: payment.provider, paymentReference: payment.reference }
            : {}),
        },
        include: packagePurchaseInclude,
        omit: packagePurchaseOmit,
      });
    });
  }

  async listProviderPurchases(providerId: string) {
    await this.ensureProviderExists(providerId);

    return this.prisma.packagePurchase.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: packagePurchaseInclude,
      omit: packagePurchaseOmit,
    });
  }

  async getProviderPurchase(providerId: string, purchaseId: string) {
    const purchase = await this.prisma.packagePurchase.findFirst({
      where: { id: purchaseId, providerId },
      include: packagePurchaseInclude,
      omit: packagePurchaseOmit,
    });

    if (!purchase) {
      throw new NotFoundException('Package purchase not found');
    }

    return purchase;
  }

  /**
   * Settles a purchase through the in-app mock form.
   *
   * This endpoint hands out credits on nothing but a well-formed card shape, so
   * it may only ever act on a purchase the mock provider opened. A process
   * wired to a real payment provider has no business exposing it at all, and a
   * purchase opened against a hosted checkout must not be settleable from
   * inside the application while the provider still considers it open — that
   * would be free credit for anyone who could reach the endpoint.
   */
  async mockPayProviderPurchase(providerId: string, purchaseId: string, dto: MockPackagePaymentDto) {
    if (resolvePaymentProviderKind() !== 'mock') {
      throw new ConflictException(
        'Mock payment is disabled: this deployment settles credit packages through its payment provider',
      );
    }

    const payment = normalizeMockPayment(dto);
    const now = new Date();

    const settled = await runSerializable(
      this.prisma,
      async (tx) => {
        const purchase = await tx.packagePurchase.findFirst({
          where: { id: purchaseId, providerId },
          include: packagePurchaseInclude,
          omit: packagePurchaseOmit,
        });

        if (!purchase) {
          throw new NotFoundException('Package purchase not found');
        }

        if (purchase.status === PackagePurchaseStatus.PAID) {
          throw new ConflictException('Package purchase is already paid');
        }

        if (purchase.status !== PackagePurchaseStatus.PENDING) {
          throw new ConflictException('Only pending package purchases can be paid');
        }

        // Belt and braces for a deployment that was switched back to `mock`
        // while purchases opened against a hosted checkout were still pending.
        if (purchase.paymentProvider !== null && purchase.paymentProvider !== 'mock') {
          throw new ConflictException(
            'This purchase was opened with a payment provider and cannot be settled by mock payment',
          );
        }

        if (payment.shouldFail) {
          return tx.packagePurchase.update({
            where: { id: purchase.id },
            data: {
              status: PackagePurchaseStatus.FAILED,
              failedAt: now,
              mockPaymentFailureReason: 'Mock payment declined: card number ends with 0000',
            },
            include: packagePurchaseInclude,
            omit: packagePurchaseOmit,
          });
        }

        /*
         * What a settled purchase produces depends on what was bought, and
         * exactly one of three things happens.
         *
         * A vitrin package grants a publication right (or, for a legacy
         * card-bound purchase, creates a placement) and moves no balance at
         * all — `creditAmountSnapshot` is zero by construction and a CHECK
         * refuses a vitrin row that carries credit. A ONE_TIME_CREDITS package
         * loads the ledger, exactly as it always has. A period package grants
         * an entitlement and touches no balance either: writing a zero-credit
         * ledger row for it would put a transaction in the provider's history
         * that says nothing happened.
         *
         * All of it happens inside this Serializable transaction, so a purchase
         * can never be PAID without whatever it bought existing beside it.
         *
         * This is the mock adapter's settlement path, and it branches the same
         * way the webhook does. Two settlement paths with one branching rule
         * between them would be one deploy away from the mock form quietly
         * doing something the real one does not.
         */
        if (purchase.kind === PackagePurchaseKind.SHOWCASE_PACKAGE) {
          if (!purchase.showcasePackageId || purchase.durationDaysSnapshot === null) {
            throw new ConflictException('This vitrin purchase is missing its package details');
          }

          if (purchase.showcaseCardId) {
            // Legacy, card-bound purchase opened before the package-first
            // flow: settles exactly as it always did, into a placement.
            if (!purchase.showcaseCardVersionId || !purchase.showcasePriceTermsAcceptanceId) {
              throw new ConflictException(
                'This vitrin purchase is missing its placement details',
              );
            }

            await this.placements.createForPurchase(
              tx,
              {
                id: purchase.id,
                providerId: purchase.providerId,
                showcasePackageId: purchase.showcasePackageId,
                showcaseCardId: purchase.showcaseCardId,
                showcaseCardVersionId: purchase.showcaseCardVersionId,
                durationDaysSnapshot: purchase.durationDaysSnapshot,
                packageNameSnapshot: purchase.packageNameSnapshot,
                priceAmountSnapshot: purchase.priceAmountSnapshot,
                currencySnapshot: purchase.currencySnapshot,
                showcasePriceTermsAcceptanceId: purchase.showcasePriceTermsAcceptanceId,
              },
              now,
            );
          } else {
            // Package-first: the money buys a right, and the right is spent
            // when the card is approved. No placement, no balance, no card yet.
            if (!purchase.showcasePackageTermsAcceptanceId) {
              throw new ConflictException('This vitrin purchase is missing its terms acceptance');
            }

            await this.entitlements.grantForPurchase(
              tx,
              {
                id: purchase.id,
                providerId: purchase.providerId,
                showcasePackageId: purchase.showcasePackageId,
                durationDaysSnapshot: purchase.durationDaysSnapshot,
                packageNameSnapshot: purchase.packageNameSnapshot,
                priceAmountSnapshot: purchase.priceAmountSnapshot,
                currencySnapshot: purchase.currencySnapshot,
                showcasePackageTermsAcceptanceId: purchase.showcasePackageTermsAcceptanceId,
              },
              now,
            );
          }

          const paidShowcase = await tx.packagePurchase.update({
            where: { id: purchase.id },
            data: {
              status: PackagePurchaseStatus.PAID,
              paidAt: now,
              mockPaymentReference: buildMockPaymentReference(now, purchase.id),
            },
            include: packagePurchaseInclude,
            omit: packagePurchaseOmit,
          });
          await this.campaignHooks.packagePaymentSucceeded(tx, purchase.providerId, purchase.id);
          return paidShowcase;
        }

        const isOneTime = purchase.package?.type === OfferPackageType.ONE_TIME_CREDITS;

        const creditTransaction = isOneTime
          ? await this.creditsService.createProviderCreditTransactionInTransaction(tx, {
              providerId: purchase.providerId,
              type: CreditTransactionType.PACKAGE_PURCHASE,
              amount: purchase.creditAmountSnapshot,
              reason: `Mock package purchase: ${purchase.packageNameSnapshot}`,
              referenceType: 'PackagePurchase',
              referenceId: purchase.id,
            })
          : null;

        if (!isOneTime) {
          if (!purchase.packageId) {
            // Unrepresentable: `PackagePurchase_kind_matches_package` requires a
            // package on every OFFER_PACKAGE row, and the vitrin branch above
            // has already returned. Narrowed rather than asserted, because a
            // settlement is not a place to discover a null.
            throw new ConflictException('This purchase is missing its package');
          }

          await grantEntitlementForPurchase(tx, {
            providerId: purchase.providerId,
            purchaseId: purchase.id,
            paidAt: now,
            packageId: purchase.packageId,
            priceAmountSnapshot: purchase.priceAmountSnapshot,
            currencySnapshot: purchase.currencySnapshot,
            packageNameSnapshot: purchase.packageNameSnapshot,
            paymentProvider: purchase.paymentProvider ?? 'mock',
          });
        }

        const paid = await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: {
            status: PackagePurchaseStatus.PAID,
            paidAt: now,
            mockPaymentReference: buildMockPaymentReference(now, purchase.id),
            ...(creditTransaction ? { creditTransactionId: creditTransaction.id } : {}),
          },
          include: packagePurchaseInclude,
          omit: packagePurchaseOmit,
        });

        // CMP-002 S2B2: the same campaign event the webhook raises, at the
        // same point — the purchase is PAID and whatever it bought exists —
        // and inside the same transaction. The mock form is the developer's
        // stand-in for a verified settlement (PAYMENT_PROVIDER=mock only), so
        // it must produce the same campaign outcome the real one would.
        await this.campaignHooks.packagePaymentSucceeded(tx, purchase.providerId, purchase.id);

        return paid;
      },
      { label: 'packagePurchases.mockPayProviderPurchase' },
    );

    // After the commit, never inside it. A declined card returns FAILED and
    // gets no receipt; a transaction that rolled back never reaches this line,
    // so there is no message and no NotificationLog row for a settlement that
    // did not happen. The service re-reads the committed rows and swallows its
    // own transport failures, so nothing here can turn a loaded balance into a
    // failed HTTP response.
    if (settled.status === PackagePurchaseStatus.PAID) {
      // The same two-receipts rule the webhook applies, for the same reason: a
      // vitrin purchase's notice is about the placement being on the air, not
      // about a balance that never moved. A package-first purchase produced no
      // placement — it granted a right — and there is no receipt for that; the
      // return screen tells the provider.
      if (settled.kind === PackagePurchaseKind.SHOWCASE_PACKAGE) {
        const placement = await this.prisma.showcasePlacement.findUnique({
          where: { purchaseId: settled.id },
          select: { id: true },
        });

        if (placement) {
          await this.mail.sendShowcasePlacementActivated(placement.id);
        } else {
          // Package-first: the right's own notice. The method re-reads the
          // committed rows and refuses anything but a PAID vitrin purchase
          // with a right behind it.
          await this.mail.sendShowcasePackagePaymentSucceeded(settled.id);
        }
      } else {
        await this.mail.sendPackagePurchaseConfirmation(settled.id);
      }
    } else if (
      settled.status === PackagePurchaseStatus.FAILED &&
      settled.kind === PackagePurchaseKind.SHOWCASE_PACKAGE
    ) {
      // The declined card. A real payment failure, so the provider is told —
      // without the card, the reason or anything else about the attempt. The
      // method itself refuses a purchase that failed before any payment page
      // opened, which is this deployment's problem rather than the buyer's.
      await this.mail.sendShowcasePackagePaymentFailed(settled.id);
    }

    return settled;
  }

  listAdminPurchases(filters: AdminPurchaseFilters) {
    const status = normalizeOptionalPurchaseStatus(filters.status);
    const providerId = normalizeNullableString(filters.providerId);
    const packageId = normalizeNullableString(filters.packageId);

    return this.prisma.packagePurchase.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(providerId ? { providerId } : {}),
        ...(packageId ? { packageId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: packagePurchaseInclude,
      omit: packagePurchaseOmit,
    });
  }

  async getAdminPurchase(id: string) {
    const purchase = await this.prisma.packagePurchase.findUnique({
      where: { id },
      include: packagePurchaseInclude,
      omit: packagePurchaseOmit,
    });

    if (!purchase) {
      throw new NotFoundException('Package purchase not found');
    }

    return { ...purchase, webhookEvents: await this.readWebhookAttempts(id) };
  }

  /**
   * What the provider's settlement notices did to this purchase, for the one
   * screen that has a use for it.
   *
   * A refused delivery and the redelivery that later settled it are the same
   * row, so the projection carries both ends: what the first refusal was, how
   * many deliveries it took, and when it resolved. That is the difference
   * between "this purchase is stuck" and "this purchase recovered", and an
   * operator cannot tell them apart from the purchase alone.
   *
   * Selected field by field on purpose. `eventKey` is left out because the
   * screen already shows the provider order id and nothing else needs it, and
   * there is nothing else on the row to leak: no payload, no signature, no
   * correlation token, no buyer detail — only short machine codes and times.
   */
  private readWebhookAttempts(purchaseId: string) {
    return this.prisma.paymentWebhookEvent.findMany({
      where: { purchaseId },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        eventName: true,
        status: true,
        detail: true,
        attemptCount: true,
        firstFailureCode: true,
        firstFailureAt: true,
        lastAttemptAt: true,
        resolvedAt: true,
        createdAt: true,
      },
    });
  }

  async updateAdminPurchaseStatus(id: string, dto: UpdatePackagePurchaseStatusDto) {
    const status = normalizeManualStatus(dto.status);
    const purchase = await this.prisma.packagePurchase.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!purchase) {
      throw new NotFoundException('Package purchase not found');
    }

    if (purchase.status !== PackagePurchaseStatus.PENDING) {
      throw new ConflictException('Only pending package purchases can be manually cancelled or expired');
    }

    const now = new Date();
    const updated = await this.prisma.packagePurchase.update({
      where: { id },
      data: {
        status,
        adminNote: normalizeNullableString(dto.adminNote),
        ...(status === PackagePurchaseStatus.CANCELLED ? { cancelledAt: now } : {}),
        ...(status === PackagePurchaseStatus.EXPIRED ? { expiredAt: now } : {}),
      },
      include: packagePurchaseInclude,
      omit: packagePurchaseOmit,
    });

    // After the write, and only for a vitrin purchase an operator cancelled:
    // the provider's checkout is not going to complete, and they are told so.
    // An expiry is not a failure — the checkout simply lapsed — and gets no
    // message. The admin note never travels; the method does not select it.
    if (
      updated.status === PackagePurchaseStatus.CANCELLED &&
      updated.kind === PackagePurchaseKind.SHOWCASE_PACKAGE
    ) {
      await this.mail.sendShowcasePackagePaymentFailed(updated.id);
    }

    return updated;
  }

  private async ensureProviderExists(providerId: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
  }
}

const packagePurchaseInclude = {
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
      type: true,
      quotaCredits: true,
      periodDays: true,
      dailyOfferLimit: true,
    },
  },
  /*
   * The vitrin half of the same row.
   *
   * Both catalogues travel on every projection rather than being selected by
   * `kind`, so a screen rendering a mixed list reads one shape: exactly one of
   * the two is non-null on any given row, and the CHECK constraint is what
   * makes that a guarantee rather than a convention.
   *
   * `ShowcasePackage.priceAmount` is what TakTick charges for the placement. It
   * is never rendered beside `ShowcaseCardVersion.listedServicePriceAmount`,
   * which is the provider's own price to their own customer and money this
   * platform does not touch — the two live on different tables under different
   * names precisely so no projection can confuse them.
   */
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
  showcaseCard: {
    select: {
      id: true,
      kind: true,
      status: true,
      category: { select: { id: true, name: true, slug: true } },
    },
  },
  showcasePlacement: {
    select: { id: true, status: true, startAt: true, endAt: true },
  },
} satisfies Prisma.PackagePurchaseInclude;

/**
 * The correlation token never leaves this process.
 *
 * It is minted for one purchase, handed to the payment provider as checkout
 * metadata, and matched back on the webhook. Nothing outside those two places
 * has a use for it, so no API response — provider's own, admin's, or otherwise
 * — carries it, and no screen can accidentally put it in a URL or a support
 * ticket. Every query that projects a purchase drops it here.
 */
export const packagePurchaseOmit = {
  paymentReference: true,
} satisfies Prisma.PackagePurchaseOmit;

function normalizeMockPayment(dto: MockPackagePaymentDto) {
  normalizeRequiredString(dto.cardholderName, 'Cardholder name');
  const cardNumber = normalizeCardNumber(dto.cardNumber);
  const currentYear = new Date().getFullYear();

  if (!Number.isInteger(dto.expiryMonth) || dto.expiryMonth < 1 || dto.expiryMonth > 12) {
    throw new BadRequestException('Expiry month must be between 1 and 12');
  }

  if (!Number.isInteger(dto.expiryYear) || dto.expiryYear < currentYear) {
    throw new BadRequestException('Expiry year must be current year or later');
  }

  if (!/^\d{3,4}$/.test(dto.cvv)) {
    throw new BadRequestException('CVV must be 3 or 4 digits');
  }

  return {
    shouldFail: cardNumber.endsWith('0000'),
  };
}

function normalizeCardNumber(value: unknown) {
  const cardNumber = normalizeRequiredString(value, 'Card number').replace(/[\s-]/g, '');

  if (!/^\d{12,19}$/.test(cardNumber)) {
    throw new BadRequestException('Card number must contain 12 to 19 digits');
  }

  return cardNumber;
}

function normalizeManualStatus(status: PackagePurchaseStatus) {
  if (status !== PackagePurchaseStatus.CANCELLED && status !== PackagePurchaseStatus.EXPIRED) {
    throw new BadRequestException('Manual status update only supports CANCELLED or EXPIRED');
  }

  return status;
}

function normalizeOptionalPurchaseStatus(status: PackagePurchaseStatus | undefined) {
  if (!status) {
    return null;
  }

  if (!Object.values(PackagePurchaseStatus).includes(status)) {
    throw new BadRequestException('Invalid package purchase status');
  }

  return status;
}

function normalizeRequiredString(value: unknown, fieldName: string) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} is required`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildMockPaymentReference(date: Date, purchaseId: string) {
  return `MOCK-${date.getTime()}-${purchaseId.slice(-6).toUpperCase()}`;
}
