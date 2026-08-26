import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditTransactionType, NumberedEntityType, PackagePurchaseStatus, Prisma } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { resolvePaymentProviderKind } from '../payments/payment-provider.config';
import { CreditsService } from '../credits/credits.service';
import { NumberingService } from '../numbering/numbering.service';
import { CreatePackagePurchaseDto } from './dto/create-package-purchase.dto';
import { MockPackagePaymentDto } from './dto/mock-package-payment.dto';
import { UpdatePackagePurchaseStatusDto } from './dto/update-package-purchase-status.dto';

type AdminPurchaseFilters = {
  status?: PackagePurchaseStatus;
  providerId?: string;
  packageId?: string;
};

@Injectable()
export class PackagePurchasesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CreditsService) private readonly creditsService: CreditsService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

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

    return runSerializable(
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

        const creditTransaction = await this.creditsService.createProviderCreditTransactionInTransaction(tx, {
          providerId: purchase.providerId,
          type: CreditTransactionType.PACKAGE_PURCHASE,
          amount: purchase.creditAmountSnapshot,
          reason: `Mock package purchase: ${purchase.packageNameSnapshot}`,
          referenceType: 'PackagePurchase',
          referenceId: purchase.id,
        });

        return tx.packagePurchase.update({
          where: { id: purchase.id },
          data: {
            status: PackagePurchaseStatus.PAID,
            paidAt: now,
            mockPaymentReference: buildMockPaymentReference(now, purchase.id),
            creditTransactionId: creditTransaction.id,
          },
          include: packagePurchaseInclude,
          omit: packagePurchaseOmit,
        });
      },
      { label: 'packagePurchases.mockPayProviderPurchase' },
    );
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
    return this.prisma.packagePurchase.update({
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
    },
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
