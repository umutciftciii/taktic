import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  NumberedEntityType,
  OfferRejectionReason,
  OfferStatus,
  Prisma,
  ProviderStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { isPhoneVerificationRequired } from '../phone-verification/phone-verification.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { NumberingService } from '../numbering/numbering.service';
import { calculateRefundEligibility } from '../offers/refund-policy';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CreateProviderDto, ProviderServiceAreaDto } from './dto/create-provider.dto';
import { UpdateProviderStatusDto } from './dto/update-provider-status.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';

type ProviderListFilters = {
  status?: string;
  city?: string;
  categoryId?: string;
};

type RequestDiscoveryFilters = {
  categoryId?: string;
  city?: string;
  district?: string;
  minQualityScore?: string;
  qualityLabel?: string;
  urgency?: string;
};

type NormalizedProviderPayload = {
  businessName: string;
  contactName: string;
  phone: string;
  email: string | null;
  taxType: string | null;
  taxNumber: string | null;
  city: string;
  district: string;
  addressNote: string | null;
  description: string | null;
  categoryIds: string[];
  serviceAreas: Array<{
    city: string;
    district: string | null;
    neighborhood: string | null;
  }>;
};

type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';
/**
 * Machine-readable codes for the offer-pricing conflicts, so the web app can
 * render a specific explanation instead of a generic error screen.
 */
export const CATEGORY_PRICE_UNSET_CODE = 'CATEGORY_PRICE_UNSET';
export const CREDIT_COST_CHANGED_CODE = 'CREDIT_COST_CHANGED';
export const CATEGORY_INACTIVE_CODE = 'CATEGORY_INACTIVE';

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  async createProvider(dto: CreateProviderDto, user: AuthUser | null = null) {
    if (user?.role === UserRole.CUSTOMER) {
      throw new ForbiddenException('Customers cannot create provider profiles');
    }

    // An account owns at most one provider profile. Checked here so the caller
    // gets an explanatory 409 rather than a raw constraint violation; the unique
    // index on ProviderProfile.userId is still the source of truth and is
    // handled below for the concurrent-request case.
    if (user?.role === UserRole.PROVIDER) {
      const existing = await this.prisma.providerProfile.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('Bu hesap için zaten bir hizmet veren profili var.');
      }
    }

    const payload = await this.normalizeAndValidatePayload(dto);

    try {
      return await this.createProviderRecord(payload, user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Bu hesap için zaten bir hizmet veren profili var.');
      }

      throw error;
    }
  }

  private createProviderRecord(
    payload: Awaited<ReturnType<ProvidersService['normalizeAndValidatePayload']>>,
    user: AuthUser | null,
  ) {
    return this.prisma.providerProfile.create({
      data: {
        userId: user?.role === UserRole.PROVIDER ? user.id : undefined,
        businessName: payload.businessName,
        contactName: payload.contactName,
        phone: payload.phone,
        email: payload.email,
        taxType: payload.taxType,
        taxNumber: payload.taxNumber,
        city: payload.city,
        district: payload.district,
        addressNote: payload.addressNote,
        description: payload.description,
        serviceCategories: {
          create: payload.categoryIds.map((categoryId) => ({
            categoryId,
          })),
        },
        serviceAreas: {
          create: payload.serviceAreas,
        },
      },
      include: providerInclude,
    });
  }

  async listProviders(filters: ProviderListFilters) {
    const status = normalizeOptionalStatus(filters.status);
    const city = normalizeNullableString(filters.city);
    const categoryId = normalizeNullableString(filters.categoryId);

    const providers = await this.prisma.providerProfile.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
        ...(categoryId
          ? {
              serviceCategories: {
                some: { categoryId },
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: providerInclude,
    });

    if (providers.length === 0) {
      return providers;
    }

    const providerIds = providers.map((provider) => provider.id);
    const metrics = await this.getProviderListMetrics(providerIds);

    return providers.map((provider) => ({
      ...provider,
      creditBalance: metrics.creditBalance.get(provider.id) ?? 0,
      activeOffersCount: metrics.activeOffers.get(provider.id) ?? 0,
      totalOffersCount: metrics.totalOffers.get(provider.id) ?? 0,
      packagePurchasesCount: metrics.packagePurchases.get(provider.id) ?? 0,
    }));
  }

  /**
   * Full record, including contact and moderation fields. Internal use only —
   * never hand this straight to an HTTP response. Public reads must go through
   * getProviderForViewer.
   */
  async getProvider(id: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id },
      include: providerInclude,
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    return provider;
  }

  /**
   * Read a provider profile through the lens of whoever is asking.
   *
   * - anonymous / any unrelated account -> public projection, and only for
   *   profiles that are publicly listable at all (see PUBLICLY_VISIBLE_STATUSES)
   * - the owning provider account        -> full record, any status
   * - SUPER_ADMIN                        -> full record, any status
   */
  async getProviderForViewer(id: string, user: AuthUser | null) {
    const provider = await this.getProvider(id);
    const visibility = resolveProviderVisibility(provider, user);

    if (visibility === 'public') {
      // 404, not 403: telling an anonymous caller "this exists but is pending"
      // would let them walk the id space and discover who applied and who was
      // rejected. An unlistable profile must be indistinguishable from a
      // non-existent one.
      if (!isPubliclyVisibleProvider(provider.status)) {
        throw new NotFoundException('Provider not found');
      }

      return toPublicProvider(provider);
    }

    return { ...provider, visibility };
  }

  async getAdminProviderDetail(id: string) {
    const provider = await this.getProvider(id);

    const [
      creditBalance,
      activeOffersCount,
      totalOffersCount,
      packagePurchasesCount,
      recentOffers,
      recentPackagePurchases,
    ] = await Promise.all([
      this.getProviderCreditBalance(id),
      this.prisma.offer.count({
        where: {
          providerId: id,
          status: {
            in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED],
          },
          request: {
            offers: { none: { status: OfferStatus.ACCEPTED } },
          },
        },
      }),
      this.prisma.offer.count({ where: { providerId: id } }),
      this.prisma.packagePurchase.count({ where: { providerId: id } }),
      this.prisma.offer.findMany({
        where: { providerId: id },
        orderBy: { submittedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          priceAmount: true,
          currency: true,
          submittedAt: true,
          request: {
            select: {
              id: true,
              city: true,
              district: true,
              category: { select: { id: true, name: true, slug: true } },
            },
          },
        },
      }),
      this.prisma.packagePurchase.findMany({
        where: { providerId: id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          packageNameSnapshot: true,
          creditAmountSnapshot: true,
          priceAmountSnapshot: true,
          currencySnapshot: true,
          createdAt: true,
          paidAt: true,
          failedAt: true,
          cancelledAt: true,
          expiredAt: true,
          refundedAt: true,
        },
      }),
    ]);

    return {
      ...provider,
      creditBalance,
      activeOffersCount,
      totalOffersCount,
      packagePurchasesCount,
      recentOffers,
      recentPackagePurchases,
    };
  }

  private async getProviderListMetrics(providerIds: string[]) {
    const [latestTransactions, activeOffersGroups, totalOffersGroups, packagePurchasesGroups] =
      await Promise.all([
        this.prisma.providerCreditTransaction.findMany({
          where: { providerId: { in: providerIds } },
          orderBy: [{ providerId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
          distinct: ['providerId'],
          select: { providerId: true, balanceAfter: true },
        }),
        this.prisma.offer.groupBy({
          by: ['providerId'],
          where: {
            providerId: { in: providerIds },
            status: {
              in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED],
            },
            request: {
              offers: { none: { status: OfferStatus.ACCEPTED } },
            },
          },
          _count: { _all: true },
        }),
        this.prisma.offer.groupBy({
          by: ['providerId'],
          where: { providerId: { in: providerIds } },
          _count: { _all: true },
        }),
        this.prisma.packagePurchase.groupBy({
          by: ['providerId'],
          where: { providerId: { in: providerIds } },
          _count: { _all: true },
        }),
      ]);

    return {
      creditBalance: new Map(
        latestTransactions.map((row) => [row.providerId, row.balanceAfter]),
      ),
      activeOffers: new Map(
        activeOffersGroups.map((row) => [row.providerId, row._count._all]),
      ),
      totalOffers: new Map(
        totalOffersGroups.map((row) => [row.providerId, row._count._all]),
      ),
      packagePurchases: new Map(
        packagePurchasesGroups.map((row) => [row.providerId, row._count._all]),
      ),
    };
  }

  async getProviderForUser(userId: string) {
    const provider = await this.prisma.providerProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: providerInclude,
    });

    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }

    return provider;
  }

  async getProviderDashboardForUser(userId: string) {
    const provider = await this.prisma.providerProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: providerInclude,
    });

    if (!provider) {
      return { provider: null };
    }

    const [creditBalance, activeOffersCount, recentOffersCount, matchingApprovedRequestsCount] =
      await Promise.all([
        this.getProviderCreditBalance(provider.id),
        this.prisma.offer.count({
          where: {
            providerId: provider.id,
            status: { in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED] },
          },
        }),
        this.prisma.offer.count({ where: { providerId: provider.id } }),
        provider.status === ProviderStatus.APPROVED
          ? this.countMatchingApprovedRequests(provider.id)
          : Promise.resolve(0),
      ]);

    return {
      provider,
      creditBalance,
      activeOffersCount,
      recentOffersCount,
      matchingApprovedRequestsCount,
    };
  }

  async updateProvider(id: string, dto: UpdateProviderDto, user: AuthUser | null = null) {
    const existingProvider = await this.getProviderForUpdate(id);
    ensureProviderUpdateAccess(existingProvider, user);
    const payload = await this.normalizeAndValidatePayload(dto);

    return this.prisma.$transaction(async (tx) => {
      await tx.providerServiceCategory.deleteMany({ where: { providerId: id } });
      await tx.providerServiceArea.deleteMany({ where: { providerId: id } });

      return tx.providerProfile.update({
        where: { id },
        data: {
          businessName: payload.businessName,
          contactName: payload.contactName,
          phone: payload.phone,
          email: payload.email,
          taxType: payload.taxType,
          taxNumber: payload.taxNumber,
          city: payload.city,
          district: payload.district,
          addressNote: payload.addressNote,
          description: payload.description,
          serviceCategories: {
            create: payload.categoryIds.map((categoryId) => ({
              categoryId,
            })),
          },
          serviceAreas: {
            create: payload.serviceAreas,
          },
        },
        include: providerInclude,
      });
    });
  }

  async updateProviderStatus(id: string, dto: UpdateProviderStatusDto) {
    await this.ensureProviderExists(id);
    const moderationNote = normalizeNullableString(dto.moderationNote);
    const rejectionReason = normalizeNullableString(dto.rejectionReason);

    if (dto.status === ProviderStatus.REJECTED && !rejectionReason) {
      throw new BadRequestException('Rejection reason is required when status is REJECTED');
    }

    const now = new Date();

    return this.prisma.providerProfile.update({
      where: { id },
      data: {
        status: dto.status,
        moderationNote,
        rejectionReason: dto.status === ProviderStatus.REJECTED ? rejectionReason : null,
        ...(dto.status === ProviderStatus.APPROVED ? { approvedAt: now } : {}),
        ...(dto.status === ProviderStatus.REJECTED ? { rejectedAt: now } : {}),
        ...(dto.status === ProviderStatus.SUSPENDED ? { suspendedAt: now } : {}),
      },
      include: providerInclude,
    });
  }

  async listMatchingRequests(providerId: string, filters: RequestDiscoveryFilters) {
    const provider = await this.getApprovedProviderForDiscovery(providerId);
    const normalizedFilters = normalizeDiscoveryFilters(filters);
    const requests = await this.prisma.serviceRequest.findMany({
      where: {
        status: ServiceRequestStatus.APPROVED,
        ...phoneVerifiedRequestFilter(),
        categoryId: { in: provider.serviceCategories.map((item) => item.categoryId) },
        offers: { none: { providerId } },
        ...(normalizedFilters.categoryId ? { categoryId: normalizedFilters.categoryId } : {}),
        ...(normalizedFilters.city ? { city: { equals: normalizedFilters.city, mode: 'insensitive' } } : {}),
        ...(normalizedFilters.district
          ? { district: { equals: normalizedFilters.district, mode: 'insensitive' } }
          : {}),
        ...(normalizedFilters.minQualityScore !== null
          ? { qualityScore: { gte: normalizedFilters.minQualityScore } }
          : {}),
        ...(normalizedFilters.urgency ? { urgency: normalizedFilters.urgency } : {}),
      },
      orderBy: [{ qualityScore: 'desc' }, { submittedAt: 'desc' }],
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
            offerCreditCost: true,
          },
        },
        _count: {
          select: { answers: true },
        },
      },
    });

    return requests
      .filter((request) => matchesProviderArea(provider.serviceAreas, request))
      .map(toProviderRequestListItem)
      .filter((request) =>
        normalizedFilters.qualityLabel ? request.qualityLabel === normalizedFilters.qualityLabel : true,
      );
  }

  async getMatchingRequest(providerId: string, requestId: string) {
    const provider = await this.getApprovedProviderForDiscovery(providerId);
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
            offerCreditCost: true,
          },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
        offers: {
          where: { providerId },
          select: {
            id: true,
            status: true,
            priceAmount: true,
            creditCost: true,
            creditSpentTransactionId: true,
            creditRefundedTransactionId: true,
            creditRefundedAt: true,
            creditRefundReason: true,
            viewedAt: true,
            acceptedAt: true,
            submittedAt: true,
          },
          take: 1,
        },
      },
    });

    if (
      !request ||
      request.status !== ServiceRequestStatus.APPROVED ||
      !isRequestVisibleToProviders(request) ||
      !provider.serviceCategories.some((item) => item.categoryId === request.categoryId) ||
      !matchesProviderArea(provider.serviceAreas, request)
    ) {
      throw new NotFoundException('Request not found');
    }

    const providerCreditBalance = await this.getProviderCreditBalance(providerId);

    return toProviderRequestDetail(request, providerCreditBalance);
  }

  async createOffer(providerId: string, requestId: string, dto: CreateOfferDto) {
    await this.ensureProviderCanSeeRequest(providerId, requestId);
    const payload = normalizeOfferPayload(dto);

    const existingOffer = await this.prisma.offer.findUnique({
      where: {
        providerId_requestId: {
          providerId,
          requestId,
        },
      },
      select: { id: true },
    });

    if (existingOffer) {
      throw new ConflictException('Provider already submitted an offer for this request');
    }

    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          // The price is read inside the transaction, in the same serialisation
          // window as the balance read and the ledger write. Reading it outside
          // would let an admin change the price between the read and the charge,
          // so the amount charged could differ from the snapshot written to the
          // offer.
          const request = await tx.serviceRequest.findUnique({
            where: { id: requestId },
            select: {
              category: {
                select: { id: true, slug: true, isActive: true, offerCreditCost: true },
              },
            },
          });

          if (!request) {
            throw new NotFoundException('Request not found');
          }

          const category = request.category;

          // A deactivated category stops accepting new offers, including on
          // requests that were already open when it was deactivated.
          if (!category.isActive) {
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              code: CATEGORY_INACTIVE_CODE,
              message: 'Bu kategori pasif durumda; yeni teklif verilemez.',
            });
          }

          const actualCreditCost = category.offerCreditCost;

          // No hidden fallback: an unpriced (or somehow non-positive) category
          // simply cannot receive offers.
          if (actualCreditCost === null || actualCreditCost <= 0) {
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              code: CATEGORY_PRICE_UNSET_CODE,
              message: 'Bu kategori için teklif kredisi tanımlı değil.',
            });
          }

          // expectedCreditCost is an equality check only — it never decides the
          // charge. Otherwise a client could set its own price by editing the
          // payload.
          if (
            payload.expectedCreditCost !== null &&
            payload.expectedCreditCost !== actualCreditCost
          ) {
            throw new ConflictException({
              statusCode: HttpStatus.CONFLICT,
              code: CREDIT_COST_CHANGED_CODE,
              message: 'Bu kategorinin teklif maliyeti güncellendi.',
              expectedCreditCost: payload.expectedCreditCost,
              actualCreditCost,
            });
          }

          const currentBalance = await getProviderCreditBalanceInTransaction(tx, providerId);
          if (currentBalance < actualCreditCost) {
            throw new HttpException('Yetersiz teklif kredisi.', HttpStatus.PAYMENT_REQUIRED);
          }

          const offerNumber = await this.numbering.generateDisplayNumber(
            tx,
            NumberedEntityType.OFFER,
          );

          const offer = await tx.offer.create({
            data: {
              providerId,
              requestId,
              offerNumber,
              priceAmount: payload.priceAmount,
              currency: payload.currency,
              estimatedStartDate: payload.estimatedStartDate,
              estimatedCompletionDate: payload.estimatedCompletionDate,
              message: payload.message,
              warrantyNote: payload.warrantyNote,
              internalNote: payload.internalNote,
              // Immutable snapshot. Refunds read this, never the live category
              // price, so a later price change cannot alter historical amounts.
              creditCost: actualCreditCost,
            },
          });

          const spendTransaction = await tx.providerCreditTransaction.create({
            data: {
              providerId,
              type: CreditTransactionType.OFFER_SPEND,
              amount: -actualCreditCost,
              balanceAfter: currentBalance - actualCreditCost,
              reason: `Offer submitted (${category.slug}, ${actualCreditCost} kredi)`,
              referenceType: 'Offer',
              referenceId: offer.id,
            },
          });

          const updatedOffer = await tx.offer.update({
            where: { id: offer.id },
            data: { creditSpentTransactionId: spendTransaction.id },
            include: providerOfferInclude,
          });

          return withRefundEligibility(updatedOffer);
        },
        { label: 'providers.createOffer' },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Provider already submitted an offer for this request');
      }

      throw error;
    }
  }

  async listProviderOffers(providerId: string) {
    await this.ensureProviderExists(providerId);

    const offers = await this.prisma.offer.findMany({
      where: { providerId },
      orderBy: { submittedAt: 'desc' },
      include: providerOfferInclude,
    });

    return offers.map(withRefundEligibility);
  }

  async getProviderOffer(providerId: string, offerId: string) {
    await this.ensureProviderExists(providerId);
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, providerId },
      include: providerOfferInclude,
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return withRefundEligibility(offer);
  }

  private async normalizeAndValidatePayload(
    dto: CreateProviderDto | UpdateProviderDto,
  ): Promise<NormalizedProviderPayload> {
    const categoryIds = normalizeCategoryIds(dto.categoryIds ?? []);
    const serviceAreas = normalizeServiceAreas(dto.serviceAreas ?? []);

    await this.ensureActiveCategories(categoryIds);

    return {
      businessName: normalizeRequiredString(dto.businessName, 'Business name'),
      contactName: normalizeRequiredString(dto.contactName, 'Contact name'),
      phone: normalizePhone(dto.phone),
      email: normalizeNullableString(dto.email),
      taxType: normalizeNullableString(dto.taxType),
      taxNumber: normalizeNullableString(dto.taxNumber),
      city: normalizeRequiredString(dto.city, 'City'),
      district: normalizeRequiredString(dto.district, 'District'),
      addressNote: normalizeNullableString(dto.addressNote),
      description: normalizeNullableString(dto.description),
      categoryIds,
      serviceAreas,
    };
  }

  private async ensureActiveCategories(categoryIds: string[]) {
    const categories = await this.prisma.serviceCategory.findMany({
      where: {
        id: { in: categoryIds },
        isActive: true,
      },
      select: { id: true },
    });

    if (categories.length !== categoryIds.length) {
      throw new BadRequestException('Category IDs must reference active categories');
    }
  }

  private async ensureProviderExists(id: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
  }

  private async getProviderForUpdate(id: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    return provider;
  }

  private async getApprovedProviderForDiscovery(providerId: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      include: {
        serviceCategories: {
          select: { categoryId: true },
        },
        serviceAreas: {
          select: { city: true, district: true, neighborhood: true },
        },
      },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    if (provider.status !== ProviderStatus.APPROVED) {
      throw new ForbiddenException('Provider must be approved to view matching requests');
    }

    return provider;
  }

  private async ensureProviderCanSeeRequest(providerId: string, requestId: string) {
    const provider = await this.getApprovedProviderForDiscovery(providerId);
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        categoryId: true,
        city: true,
        district: true,
        neighborhood: true,
        phoneVerifiedAt: true,
      },
    });

    if (
      !request ||
      request.status !== ServiceRequestStatus.APPROVED ||
      !isRequestVisibleToProviders(request) ||
      !provider.serviceCategories.some((item) => item.categoryId === request.categoryId) ||
      !matchesProviderArea(provider.serviceAreas, request)
    ) {
      throw new NotFoundException('Request not found');
    }
  }

  private async getProviderCreditBalance(providerId: string) {
    const latestTransaction = await this.prisma.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true },
    });

    return latestTransaction?.balanceAfter ?? 0;
  }

  private async countMatchingApprovedRequests(providerId: string) {
    const requests = await this.listMatchingRequests(providerId, {});
    return requests.length;
  }
}

const providerInclude = {
  user: {
    select: { id: true, email: true, phone: true, name: true, role: true },
  },
  serviceCategories: {
    include: {
      category: {
        select: { id: true, name: true, slug: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  serviceAreas: {
    orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
  },
} satisfies Prisma.ProviderProfileInclude;

export type ProviderVisibility = 'public' | 'owner' | 'admin';

/**
 * Only an approved provider is a public entity. Everything else — a draft, an
 * application under review, a rejected or suspended profile — is private
 * moderation state and must not be discoverable by id.
 *
 * Deliberately an allow-list: a status added later stays private until someone
 * consciously decides it should be public.
 */
const PUBLICLY_VISIBLE_STATUSES: ReadonlySet<ProviderStatus> = new Set([ProviderStatus.APPROVED]);

export function isPubliclyVisibleProvider(status: ProviderStatus): boolean {
  return PUBLICLY_VISIBLE_STATUSES.has(status);
}

function resolveProviderVisibility(
  provider: { userId: string | null },
  user: AuthUser | null,
): ProviderVisibility {
  if (!user) {
    return 'public';
  }

  if (user.role === UserRole.SUPER_ADMIN) {
    return 'admin';
  }

  if (user.role === UserRole.PROVIDER && provider.userId && provider.userId === user.id) {
    return 'owner';
  }

  return 'public';
}

/**
 * The only shape an unauthenticated or unrelated caller may see.
 *
 * Deliberately omitted: the linked platform `user` object, phone, e-mail,
 * contactName, tax type/number, addressNote, and the moderation fields
 * (moderationNote, rejectionReason, approved/rejected/suspended timestamps).
 * Built as an allow-list so a future column is private until someone
 * consciously adds it here.
 */
function toPublicProvider(
  provider: Prisma.ProviderProfileGetPayload<{ include: typeof providerInclude }>,
) {
  return {
    id: provider.id,
    businessName: provider.businessName,
    city: provider.city,
    district: provider.district,
    description: provider.description,
    status: provider.status,
    createdAt: provider.createdAt,
    serviceCategories: provider.serviceCategories,
    serviceAreas: provider.serviceAreas,
    visibility: 'public' as const,
  };
}

function ensureProviderUpdateAccess(
  provider: { userId: string | null },
  user: AuthUser | null,
) {
  if (!user) {
    throw new ForbiddenException('Provider profile requires authentication');
  }

  if (user.role === UserRole.SUPER_ADMIN) {
    return;
  }

  if (user.role === UserRole.CUSTOMER) {
    throw new ForbiddenException('Customers cannot update provider profiles');
  }

  // Guest applications have no owner yet. Until a claim flow exists they are
  // administrable only — anonymous or third-party edits are never allowed.
  if (!provider.userId) {
    throw new ForbiddenException('Unclaimed provider profiles can only be updated by an admin');
  }

  if (user.role !== UserRole.PROVIDER || user.id !== provider.userId) {
    throw new ForbiddenException('Provider access denied');
  }
}

const providerOfferInclude = {
  request: {
    select: {
      id: true,
      requestNumber: true,
      city: true,
      district: true,
      neighborhood: true,
      budgetMin: true,
      budgetMax: true,
      preferredDate: true,
      urgency: true,
      qualityScore: true,
      status: true,
      category: {
        select: { id: true, name: true, slug: true },
      },
    },
  },
} satisfies Prisma.OfferInclude;

function normalizeCategoryIds(categoryIds: string[]) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    throw new BadRequestException('At least one categoryId is required');
  }

  const normalized = categoryIds.map((categoryId) => normalizeRequiredString(categoryId, 'Category ID'));
  const uniqueIds = new Set(normalized);

  if (uniqueIds.size !== normalized.length) {
    throw new BadRequestException('Duplicate categoryIds are not allowed');
  }

  return normalized;
}

function normalizeServiceAreas(serviceAreas: ProviderServiceAreaDto[]) {
  if (!Array.isArray(serviceAreas) || serviceAreas.length === 0) {
    throw new BadRequestException('At least one service area is required');
  }

  const normalized = serviceAreas.map((area) => ({
    city: normalizeRequiredString(area.city, 'Service area city'),
    district: normalizeNullableString(area.district),
    neighborhood: normalizeNullableString(area.neighborhood),
  }));
  const keys = normalized.map((area) =>
    [area.city.toLocaleLowerCase('tr-TR'), area.district?.toLocaleLowerCase('tr-TR') ?? '', area.neighborhood?.toLocaleLowerCase('tr-TR') ?? ''].join('|'),
  );

  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException('Duplicate service areas are not allowed');
  }

  return normalized;
}

function normalizeOptionalStatus(value: string | undefined) {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }

  if (!Object.values(ProviderStatus).includes(normalized as ProviderStatus)) {
    throw new BadRequestException('Invalid provider status filter');
  }

  return normalized as ProviderStatus;
}

function normalizeDiscoveryFilters(filters: RequestDiscoveryFilters) {
  const minQualityScore = normalizeOptionalScore(filters.minQualityScore);

  return {
    categoryId: normalizeNullableString(filters.categoryId),
    city: normalizeNullableString(filters.city),
    district: normalizeNullableString(filters.district),
    minQualityScore,
    qualityLabel: normalizeOptionalQualityLabel(filters.qualityLabel),
    urgency: normalizeNullableString(filters.urgency),
  };
}

function normalizeOptionalScore(value: string | undefined) {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }

  const score = Number(normalized);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new BadRequestException('minQualityScore must be an integer between 0 and 100');
  }

  return score;
}

function normalizeOptionalQualityLabel(value: string | undefined): QualityLabel | null {
  const normalized = normalizeNullableString(value)?.toUpperCase();

  if (!normalized) {
    return null;
  }

  if (normalized !== 'LOW' && normalized !== 'MEDIUM' && normalized !== 'HIGH') {
    throw new BadRequestException('qualityLabel must be LOW, MEDIUM, or HIGH');
  }

  return normalized;
}

/**
 * Provider-side visibility gate for unverified requests.
 *
 * While REQUIRE_PHONE_VERIFICATION is false this is a no-op, so requests that
 * predate phone verification — every existing row — keep behaving exactly as
 * before. When it is true, an unverified request is invisible to providers, and
 * the check is applied in the list query, the detail lookup and the offer path
 * alike: hiding it in the UI only would still leave the id guessable.
 */
function phoneVerifiedRequestFilter(): Prisma.ServiceRequestWhereInput {
  return isPhoneVerificationRequired() ? { phoneVerifiedAt: { not: null } } : {};
}

function isRequestVisibleToProviders(request: { phoneVerifiedAt: Date | null }): boolean {
  return !isPhoneVerificationRequired() || request.phoneVerifiedAt !== null;
}

function matchesProviderArea(
  areas: Array<{ city: string; district: string | null; neighborhood: string | null }>,
  request: { city: string; district: string; neighborhood: string | null },
) {
  return areas.some((area) => {
    if (!sameText(area.city, request.city)) {
      return false;
    }

    if (area.district && !sameText(area.district, request.district)) {
      return false;
    }

    if (area.neighborhood && !sameText(area.neighborhood, request.neighborhood)) {
      return false;
    }

    return true;
  });
}

function sameText(left: string | null, right: string | null) {
  return (left ?? '').toLocaleLowerCase('tr-TR') === (right ?? '').toLocaleLowerCase('tr-TR');
}

export type OfferBlockedReason = 'CATEGORY_INACTIVE' | 'CATEGORY_PRICE_UNSET';

/**
 * Derives what the provider UI needs to decide whether an offer can be made and
 * what it would cost. Mirrors the checks createOffer performs inside its
 * transaction, so the screen never invites an action the API would reject.
 *
 * `offerCreditCost` is null exactly when offering is impossible, and
 * `offerBlockedReason` says which rule blocks it.
 */
function resolveOfferPricing(category: { isActive: boolean; offerCreditCost: number | null }): {
  offerCreditCost: number | null;
  canOffer: boolean;
  offerBlockedReason: OfferBlockedReason | null;
} {
  if (!category.isActive) {
    return { offerCreditCost: null, canOffer: false, offerBlockedReason: 'CATEGORY_INACTIVE' };
  }

  if (category.offerCreditCost === null || category.offerCreditCost <= 0) {
    return { offerCreditCost: null, canOffer: false, offerBlockedReason: 'CATEGORY_PRICE_UNSET' };
  }

  return { offerCreditCost: category.offerCreditCost, canOffer: true, offerBlockedReason: null };
}

function toProviderRequestListItem(
  request: Prisma.ServiceRequestGetPayload<{
    include: {
      category: {
        select: { id: true; name: true; slug: true; isActive: true; offerCreditCost: true };
      };
      _count: { select: { answers: true } };
    };
  }>,
) {
  const pricing = resolveOfferPricing(request.category);

  return {
    id: request.id,
    category: request.category,
    ...pricing,
    city: request.city,
    district: request.district,
    neighborhood: request.neighborhood,
    budgetMin: request.budgetMin,
    budgetMax: request.budgetMax,
    preferredDate: request.preferredDate,
    urgency: request.urgency,
    qualityScore: request.qualityScore,
    qualityLabel: qualityLabel(request.qualityScore),
    submittedAt: request.submittedAt,
    createdAt: request.createdAt,
    answersCount: request._count.answers,
  };
}

function toProviderRequestDetail(
  request: Prisma.ServiceRequestGetPayload<{
    include: {
      category: {
        select: { id: true; name: true; slug: true; isActive: true; offerCreditCost: true };
      };
      answers: true;
      offers: {
        where: { providerId: string };
        select: {
          id: true;
          status: true;
          priceAmount: true;
          creditCost: true;
          creditSpentTransactionId: true;
          creditRefundedTransactionId: true;
          creditRefundedAt: true;
          creditRefundReason: true;
          viewedAt: true;
          acceptedAt: true;
          submittedAt: true;
        };
        take: 1;
      };
    };
  }>,
  providerCreditBalance: number,
) {
  const pricing = resolveOfferPricing(request.category);

  return {
    id: request.id,
    category: request.category,
    ...pricing,
    city: request.city,
    district: request.district,
    neighborhood: request.neighborhood,
    addressNote: request.addressNote,
    budgetMin: request.budgetMin,
    budgetMax: request.budgetMax,
    preferredDate: request.preferredDate,
    urgency: request.urgency,
    description: request.description,
    qualityScore: request.qualityScore,
    qualityLabel: qualityLabel(request.qualityScore),
    qualityScoreBreakdown: request.qualityScoreBreakdown,
    submittedAt: request.submittedAt,
    createdAt: request.createdAt,
    existingOffer: request.offers[0] ? withRefundEligibility(request.offers[0]) : null,
    providerCreditBalance,
    answers: request.answers.map((answer) => ({
      id: answer.id,
      questionKey: answer.questionKey,
      questionLabel: answer.questionLabel,
      questionType: answer.questionType,
      value: answer.value,
      createdAt: answer.createdAt,
    })),
  };
}

function withRefundEligibility<T extends RefundPolicyOfferShape>(offer: T) {
  // rejectionReason is internal. COMPETITOR_ACCEPTED tells the provider that
  // somebody else won, which is exactly what the provider must not learn, so it
  // is dropped here. What stays is refundEligibility, whose label for that case
  // is the neutral "Teklif kabul edilmedi".
  const { rejectionReason, ...visible } = offer;
  void rejectionReason;

  return {
    ...visible,
    refundEligibility: calculateRefundEligibility(offer),
  };
}

type RefundPolicyOfferShape = {
  status: OfferStatus;
  submittedAt: Date | string | null;
  viewedAt: Date | string | null;
  acceptedAt: Date | string | null;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: Date | string | null;
  rejectionReason?: OfferRejectionReason | null;
};

async function getProviderCreditBalanceInTransaction(
  tx: Prisma.TransactionClient,
  providerId: string,
) {
  const latestTransaction = await tx.providerCreditTransaction.findFirst({
    where: { providerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { balanceAfter: true },
  });

  return latestTransaction?.balanceAfter ?? 0;
}

function normalizeOfferPayload(dto: CreateOfferDto) {
  // priceAmount is stored in minor units (e.g. kuruş for TRY). The DTO already
  // enforces @IsInt + @Min(100); this is the defence-in-depth check.
  const priceAmount = dto.priceAmount;
  if (!Number.isInteger(priceAmount) || priceAmount < 100) {
    throw new BadRequestException(
      'priceAmount must be a positive integer in minor units (kuruş) and at least 100 (1,00).',
    );
  }

  const message = normalizeRequiredString(dto.message, 'Message');
  const estimatedStartDate = normalizeOptionalDate(dto.estimatedStartDate, 'Estimated start date');
  const estimatedCompletionDate = normalizeOptionalDate(
    dto.estimatedCompletionDate,
    'Estimated completion date',
  );

  if (
    estimatedStartDate &&
    estimatedCompletionDate &&
    estimatedCompletionDate.getTime() < estimatedStartDate.getTime()
  ) {
    throw new BadRequestException('Estimated completion date must be after estimated start date');
  }

  return {
    priceAmount,
    // Carried through untouched: it is compared against the live category price
    // inside the transaction and is never used as the charged amount.
    expectedCreditCost: dto.expectedCreditCost ?? null,
    currency: normalizeNullableString(dto.currency) ?? 'TRY',
    estimatedStartDate,
    estimatedCompletionDate,
    message,
    warrantyNote: normalizeNullableString(dto.warrantyNote),
    internalNote: normalizeNullableString(dto.internalNote),
  };
}

function normalizeOptionalDate(value: string | null | undefined, fieldName: string) {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${fieldName} must be a valid date`);
  }

  return date;
}

function qualityLabel(score: number): QualityLabel {
  if (score >= 80) {
    return 'HIGH';
  }

  if (score >= 50) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function normalizePhone(value: string) {
  return normalizeRequiredString(value, 'Phone').replace(/[^\d+]/g, '');
}
