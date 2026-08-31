import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OfferPackageType,
  Prisma,
  ProviderEntitlementStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { PaymentProviderPort } from '../payments/payment-provider.port';
import { PACKAGE_PERIOD_DAYS, istanbulDayStart } from './entitlement-period';

export const AUTO_RENEW_UNSUPPORTED_CODE = 'AUTO_RENEW_UNSUPPORTED';

/**
 * Everything a provider and an admin are allowed to know about bought periods.
 *
 * Two projections, and the difference between them is the point of the file.
 * Neither of them can carry a payment credential: `paymentMethodReference` is
 * never selected into either one, and the admin view reports only *whether* a
 * payment method is on file. The renewal attempt's `providerTransactionRef` —
 * the payment provider's own opaque order id, the thing an operator needs to
 * find the transaction on the provider's side — is admin-only.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentProviderPort) private readonly payments: PaymentProviderPort,
  ) {}

  /**
   * Whether automatic renewal can be offered at all, and why not when it
   * cannot.
   *
   * Read from the bound adapter rather than from configuration: it is a fact
   * about what the integration can do, and a deployment must not be able to
   * turn it on by setting a variable.
   */
  readAutoRenewCapability() {
    const { automaticRenewal, automaticRenewalUnsupportedReason } = this.payments.capabilities;

    return {
      available: automaticRenewal,
      unsupportedReason: automaticRenewal ? null : automaticRenewalUnsupportedReason,
      /**
       * What the screens say when it is unavailable. Stated here so the web app
       * and the admin app cannot drift into two different explanations, and
       * worded as a fact rather than a promise: there is no "coming soon".
       */
      message: automaticRenewal
        ? null
        : 'Bu kurulumda otomatik yenileme kullanılamıyor: ödeme sağlayıcısı, uygulamanın kayıtlı bir ödeme yöntemini sizin adınıza tekrar tahsil etmesine izin vermiyor. Paketiniz bittiğinde aynı paketi elle yenileyebilirsiniz.',
      periodDays: PACKAGE_PERIOD_DAYS,
    };
  }

  /** The provider's own periods, newest first. */
  async listProviderEntitlements(providerId: string) {
    await this.ensureProviderExists(providerId);
    const now = new Date();

    const entitlements = await this.prisma.providerPackageEntitlement.findMany({
      where: { providerId },
      orderBy: [{ endAt: 'desc' }, { createdAt: 'desc' }],
      select: providerEntitlementSelect,
    });

    const dailyUsage = await this.readDailyUsage(entitlements, now);

    return {
      providerId,
      autoRenew: this.readAutoRenewCapability(),
      entitlements: entitlements.map((item) => presentForProvider(item, now, dailyUsage)),
    };
  }

  /**
   * Turns automatic renewal on or off for one period.
   *
   * Turning it *on* is refused outright while no adapter can charge a stored
   * payment method. That refusal is the whole design: a switch that flipped and
   * then quietly never charged anything would leave a provider believing their
   * access renews, and they would find out it did not on the day it lapsed.
   *
   * Turning it *off* is always allowed, including on a period whose switch was
   * on before an adapter lost the capability, and it never shortens the period —
   * see {@link cancelAutoRenew}.
   */
  async setAutoRenew(providerId: string, entitlementId: string, enabled: boolean) {
    const entitlement = await this.readOwnEntitlement(providerId, entitlementId);

    if (enabled) {
      const capability = this.readAutoRenewCapability();
      if (!capability.available) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: AUTO_RENEW_UNSUPPORTED_CODE,
          message: capability.message,
          unsupportedReason: capability.unsupportedReason,
        });
      }

      if (entitlement.type === OfferPackageType.ONE_TIME_CREDITS) {
        throw new BadRequestException('Tek seferlik kredi paketleri yenilenmez');
      }
    }

    const now = new Date();
    await this.prisma.providerPackageEntitlement.update({
      where: { id: entitlement.id },
      data: {
        autoRenewEnabled: enabled,
        // Never a record of a consent that no longer stands.
        autoRenewConsentAt: enabled ? now : null,
        cancelledAt: enabled ? null : (entitlement.cancelledAt ?? now),
      },
    });

    return this.listProviderEntitlements(providerId);
  }

  /**
   * Cancels the next charge, and only the next charge.
   *
   * `endAt` is not touched and the status stays ACTIVE, so a provider who
   * cancels on day 3 keeps every one of the remaining 27 days they paid for.
   * The period lapses on its own when the clock reaches `endAt`.
   */
  cancelAutoRenew(providerId: string, entitlementId: string) {
    return this.setAutoRenew(providerId, entitlementId, false);
  }

  /**
   * What an admin may see about one provider's periods.
   *
   * Adds the audit trail — the renewal attempts, their outcome codes and the
   * payment provider's own opaque transaction reference — and still carries no
   * credential: whether a payment method is on file is a boolean, and the
   * reference itself is never selected.
   */
  async listProviderEntitlementsForAdmin(providerId: string) {
    await this.ensureProviderExists(providerId);
    const now = new Date();

    const entitlements = await this.prisma.providerPackageEntitlement.findMany({
      where: { providerId },
      orderBy: [{ endAt: 'desc' }, { createdAt: 'desc' }],
      select: adminEntitlementSelect,
    });

    return {
      providerId,
      autoRenew: this.readAutoRenewCapability(),
      entitlements: entitlements.map((item) => ({
        ...presentForProvider(item, now, new Map()),
        purchaseId: item.purchaseId,
        purchaseNumber: item.purchase?.purchaseNumber ?? null,
        paymentProvider: item.paymentProvider,
        /** Whether a stored payment method exists. Never the reference itself. */
        paymentMethodOnFile: item.paymentMethodReference !== null,
        renewalAttempts: item.renewalAttempts.map((attempt) => ({
          id: attempt.id,
          periodIndex: attempt.periodIndex,
          status: attempt.status,
          failureCode: attempt.failureCode,
          paymentProvider: attempt.paymentProvider,
          providerTransactionRef: attempt.providerTransactionRef,
          attemptedAt: attempt.attemptedAt,
        })),
      })),
    };
  }

  /**
   * Marks every period whose clock has run out.
   *
   * Purely bookkeeping: nothing reads the status without also reading `endAt`,
   * so a sweeper that has not run yet, or has stopped, cannot hand out an extra
   * day of access. It exists so the screens and the admin lists can filter on a
   * status instead of on arithmetic.
   */
  async expireDuePeriods(now = new Date()) {
    const expired = await this.prisma.providerPackageEntitlement.updateMany({
      where: { status: ProviderEntitlementStatus.ACTIVE, endAt: { lte: now } },
      data: { status: ProviderEntitlementStatus.EXPIRED },
    });

    return { expired: expired.count };
  }

  private async readOwnEntitlement(providerId: string, entitlementId: string) {
    const entitlement = await this.prisma.providerPackageEntitlement.findFirst({
      where: { id: entitlementId, providerId },
      select: { id: true, type: true, cancelledAt: true },
    });

    if (!entitlement) {
      throw new NotFoundException('Paket bulunamadı');
    }

    return entitlement;
  }

  /**
   * How many offers each unlimited period has already paid for today.
   *
   * One grouped count for the whole list rather than one per row, and only for
   * the periods that actually carry a cap.
   */
  private async readDailyUsage(
    entitlements: { id: string; dailyOfferLimitSnapshot: number | null }[],
    now: Date,
  ) {
    const capped = entitlements
      .filter((item) => item.dailyOfferLimitSnapshot !== null)
      .map((item) => item.id);

    if (capped.length === 0) {
      return new Map<string, number>();
    }

    const grouped = await this.prisma.offer.groupBy({
      by: ['entitlementId'],
      where: { entitlementId: { in: capped }, submittedAt: { gte: istanbulDayStart(now) } },
      _count: { _all: true },
    });

    return new Map(
      grouped.map((row) => [row.entitlementId as string, row._count._all] as const),
    );
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

/**
 * Buying is an act of the account that owns the provider, and so is changing
 * what it renews into. An admin who needs to intervene has the audited credit
 * endpoints; they do not get to switch somebody else's billing on.
 */
export function assertProviderAccount(user: AuthUser) {
  if (user.role !== UserRole.PROVIDER) {
    throw new ForbiddenException('Bu işlemi yalnızca hizmet veren hesabı yapabilir');
  }
}

const scopeSelect = {
  categoryId: true,
  categoryNameSnapshot: true,
  categoryKindSnapshot: true,
} satisfies Prisma.ProviderPackageEntitlementScopeSelect;

const providerEntitlementSelect = {
  id: true,
  type: true,
  packageNameSnapshot: true,
  priceAmountSnapshot: true,
  currencySnapshot: true,
  quotaCreditsSnapshot: true,
  remainingQuota: true,
  dailyOfferLimitSnapshot: true,
  periodDaysSnapshot: true,
  startAt: true,
  endAt: true,
  status: true,
  periodIndex: true,
  autoRenewEnabled: true,
  autoRenewConsentAt: true,
  cancelledAt: true,
  lastRenewalAttemptAt: true,
  lastRenewalFailureCode: true,
  createdAt: true,
  packageId: true,
  scopes: { where: { selected: true }, select: scopeSelect, orderBy: { categoryNameSnapshot: 'asc' } },
} satisfies Prisma.ProviderPackageEntitlementSelect;

const adminEntitlementSelect = {
  ...providerEntitlementSelect,
  purchaseId: true,
  paymentProvider: true,
  paymentMethodReference: true,
  purchase: { select: { purchaseNumber: true } },
  renewalAttempts: {
    orderBy: { attemptedAt: 'desc' },
    select: {
      id: true,
      periodIndex: true,
      status: true,
      failureCode: true,
      paymentProvider: true,
      providerTransactionRef: true,
      attemptedAt: true,
    },
  },
} satisfies Prisma.ProviderPackageEntitlementSelect;

type ProviderEntitlementRow = Prisma.ProviderPackageEntitlementGetPayload<{
  select: typeof providerEntitlementSelect;
}>;

function presentForProvider(
  entitlement: ProviderEntitlementRow,
  now: Date,
  dailyUsage: Map<string, number>,
) {
  const usable =
    entitlement.status === ProviderEntitlementStatus.ACTIVE &&
    entitlement.startAt.getTime() <= now.getTime() &&
    entitlement.endAt.getTime() > now.getTime();

  return {
    id: entitlement.id,
    packageId: entitlement.packageId,
    type: entitlement.type,
    packageName: entitlement.packageNameSnapshot,
    priceAmount: entitlement.priceAmountSnapshot,
    currency: entitlement.currencySnapshot,
    startAt: entitlement.startAt,
    endAt: entitlement.endAt,
    periodDays: entitlement.periodDaysSnapshot,
    status: entitlement.status,
    /** True only while the period is both ACTIVE and inside its own clock. */
    usable,
    /** A period that has been paid for but has not started yet (a renewal). */
    queued: entitlement.status === ProviderEntitlementStatus.ACTIVE && entitlement.startAt > now,
    quotaTotal: entitlement.quotaCreditsSnapshot,
    quotaRemaining: entitlement.remainingQuota,
    dailyOfferLimit: entitlement.dailyOfferLimitSnapshot,
    dailyOfferUsed: entitlement.dailyOfferLimitSnapshot === null
      ? null
      : (dailyUsage.get(entitlement.id) ?? 0),
    scope: entitlement.scopes.map((scope) => ({
      categoryId: scope.categoryId,
      name: scope.categoryNameSnapshot,
      kind: scope.categoryKindSnapshot,
    })),
    autoRenewEnabled: entitlement.autoRenewEnabled,
    autoRenewConsentAt: entitlement.autoRenewConsentAt,
    cancelledAt: entitlement.cancelledAt,
    lastRenewalAttemptAt: entitlement.lastRenewalAttemptAt,
    /**
     * The failure class, never the payment provider's own words. The screens
     * map it onto neutral wording; nothing about a card reaches this response.
     */
    lastRenewalFailureCode: entitlement.lastRenewalFailureCode,
    periodIndex: entitlement.periodIndex,
    createdAt: entitlement.createdAt,
  };
}
