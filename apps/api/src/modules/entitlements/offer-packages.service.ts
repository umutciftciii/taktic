import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { OfferPackageType, Prisma, ProviderEntitlementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PACKAGE_PERIOD_DAYS } from './entitlement-period';
import { ALREADY_QUEUED_CODE, SCOPE_CONFLICT_CODE } from './entitlement-grant';

/**
 * The buying screen's catalogue.
 *
 * Deliberately not on the public `GET /credit-packages` endpoint, which is
 * unauthenticated and stays exactly as it was — one-time credit packages only.
 * Everything a period package would add to that response (its quota, its
 * category scope, its daily cap, and whether *this* provider may buy it) is
 * information about a provider's commercial position, so it lives behind the
 * provider's own authorisation.
 */
@Injectable()
export class OfferPackagesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Everything this provider can be offered, already sorted into the three
   * groups the screen renders and already annotated with why a package cannot
   * be bought right now.
   *
   * The "why not" is computed here rather than left to the screen so the
   * buying screen and the checkout endpoint answer with the same rule — the
   * checkout re-checks it anyway, and a button that opens a checkout which then
   * refuses is worse than a button that is disabled with a reason.
   */
  async listForProvider(providerId: string) {
    await this.ensureProviderExists(providerId);
    const now = new Date();

    const packages = await this.prisma.offerCreditPackage.findMany({
      where: { isActive: true },
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: packageSelect,
    });

    const held = await this.prisma.providerPackageEntitlement.findMany({
      where: {
        providerId,
        status: ProviderEntitlementStatus.ACTIVE,
        endAt: { gt: now },
      },
      select: {
        packageId: true,
        type: true,
        startAt: true,
        packageNameSnapshot: true,
        scopes: { select: { categoryId: true } },
      },
    });

    const queuedPackageIds = new Set(
      held.filter((item) => item.startAt > now).map((item) => item.packageId),
    );

    return {
      providerId,
      periodDays: PACKAGE_PERIOD_DAYS,
      packages: packages.map((pkg) => this.present(pkg, held, queuedPackageIds)),
    };
  }

  private present(
    pkg: PackageRow,
    held: HeldEntitlement[],
    queuedPackageIds: Set<string>,
  ) {
    const scope = pkg.scopeCategories.map((row) => ({
      categoryId: row.category.id,
      name: row.category.name,
      kind: row.category.kind,
      status: row.category.status,
    }));

    return {
      id: pkg.id,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description,
      type: pkg.type,
      priceAmount: pkg.priceAmount,
      currency: pkg.currency,
      /** Meaningful only for ONE_TIME_CREDITS; zero for the period products. */
      creditAmount: pkg.creditAmount,
      quotaCredits: pkg.quotaCredits,
      periodDays: pkg.periodDays,
      dailyOfferLimit: pkg.dailyOfferLimit,
      scope,
      ...this.availability(pkg, held, queuedPackageIds),
    };
  }

  /**
   * Whether this provider may buy this package right now, and the same machine
   * code the checkout would refuse with.
   */
  private availability(
    pkg: PackageRow,
    held: HeldEntitlement[],
    queuedPackageIds: Set<string>,
  ) {
    if (pkg.type === OfferPackageType.ONE_TIME_CREDITS) {
      return { purchasable: true, unavailableCode: null, unavailableReason: null };
    }

    if (queuedPackageIds.has(pkg.id)) {
      return {
        purchasable: false,
        unavailableCode: ALREADY_QUEUED_CODE,
        unavailableReason:
          'Bu paket için bir sonraki dönem zaten sıraya alındı. Mevcut dönem bitince tekrar yenileyebilirsiniz.',
      };
    }

    if (pkg.type !== OfferPackageType.CATEGORY_UNLIMITED) {
      return { purchasable: true, unavailableCode: null, unavailableReason: null };
    }

    const wanted = new Set(pkg.scopeCategories.map((row) => row.category.id));
    const conflict = held.find(
      (item) =>
        item.type === OfferPackageType.CATEGORY_UNLIMITED &&
        item.packageId !== pkg.id &&
        item.scopes.some((scope) => wanted.has(scope.categoryId)),
    );

    if (conflict) {
      return {
        purchasable: false,
        unavailableCode: SCOPE_CONFLICT_CODE,
        unavailableReason: `"${conflict.packageNameSnapshot}" paketiniz bu kategorileri zaten kapsıyor.`,
      };
    }

    return { purchasable: true, unavailableCode: null, unavailableReason: null };
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

const packageSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  type: true,
  priceAmount: true,
  currency: true,
  creditAmount: true,
  quotaCredits: true,
  periodDays: true,
  dailyOfferLimit: true,
  scopeCategories: {
    select: { category: { select: { id: true, name: true, kind: true, status: true } } },
    orderBy: { category: { name: 'asc' } },
  },
} satisfies Prisma.OfferCreditPackageSelect;

type PackageRow = Prisma.OfferCreditPackageGetPayload<{ select: typeof packageSelect }>;

type HeldEntitlement = {
  packageId: string;
  type: OfferPackageType;
  startAt: Date;
  packageNameSnapshot: string;
  scopes: { categoryId: string }[];
};
