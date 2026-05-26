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
import { CreditTransactionType, Prisma, ProviderStatus, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
const OFFER_CREDIT_COST = 1;

@Injectable()
export class ProvidersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createProvider(dto: CreateProviderDto) {
    const payload = await this.normalizeAndValidatePayload(dto);

    return this.prisma.providerProfile.create({
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
  }

  listProviders(filters: ProviderListFilters) {
    const status = normalizeOptionalStatus(filters.status);
    const city = normalizeNullableString(filters.city);
    const categoryId = normalizeNullableString(filters.categoryId);

    return this.prisma.providerProfile.findMany({
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
  }

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

  async updateProvider(id: string, dto: UpdateProviderDto) {
    await this.ensureProviderExists(id);
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
        categoryId: { in: provider.serviceCategories.map((item) => item.categoryId) },
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
          select: { id: true, name: true, slug: true },
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
          select: { id: true, name: true, slug: true },
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
            creditRefundedAt: true,
            creditRefundReason: true,
            submittedAt: true,
          },
          take: 1,
        },
      },
    });

    if (
      !request ||
      request.status !== ServiceRequestStatus.APPROVED ||
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
      return await this.prisma.$transaction(
        async (tx) => {
          const currentBalance = await getProviderCreditBalanceInTransaction(tx, providerId);
          if (currentBalance < OFFER_CREDIT_COST) {
            throw new HttpException('Yetersiz teklif kredisi.', HttpStatus.PAYMENT_REQUIRED);
          }

          const offer = await tx.offer.create({
            data: {
              providerId,
              requestId,
              priceAmount: payload.priceAmount,
              currency: payload.currency,
              estimatedStartDate: payload.estimatedStartDate,
              estimatedCompletionDate: payload.estimatedCompletionDate,
              message: payload.message,
              warrantyNote: payload.warrantyNote,
              internalNote: payload.internalNote,
              creditCost: OFFER_CREDIT_COST,
            },
          });

          const spendTransaction = await tx.providerCreditTransaction.create({
            data: {
              providerId,
              type: CreditTransactionType.OFFER_SPEND,
              amount: -OFFER_CREDIT_COST,
              balanceAfter: currentBalance - OFFER_CREDIT_COST,
              reason: 'Offer submitted',
              referenceType: 'Offer',
              referenceId: offer.id,
            },
          });

          return tx.offer.update({
            where: { id: offer.id },
            data: { creditSpentTransactionId: spendTransaction.id },
            include: providerOfferInclude,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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

    return this.prisma.offer.findMany({
      where: { providerId },
      orderBy: { submittedAt: 'desc' },
      include: providerOfferInclude,
    });
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

    return offer;
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
      },
    });

    if (
      !request ||
      request.status !== ServiceRequestStatus.APPROVED ||
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
}

const providerInclude = {
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

const providerOfferInclude = {
  request: {
    select: {
      id: true,
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

function toProviderRequestListItem(
  request: Prisma.ServiceRequestGetPayload<{
    include: {
      category: { select: { id: true; name: true; slug: true } };
      _count: { select: { answers: true } };
    };
  }>,
) {
  return {
    id: request.id,
    category: request.category,
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
      category: { select: { id: true; name: true; slug: true } };
      answers: true;
      offers: {
        where: { providerId: string };
        select: {
          id: true;
          status: true;
          priceAmount: true;
          creditCost: true;
          creditRefundedAt: true;
          creditRefundReason: true;
          submittedAt: true;
        };
        take: 1;
      };
    };
  }>,
  providerCreditBalance: number,
) {
  return {
    id: request.id,
    category: request.category,
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
    existingOffer: request.offers[0] ?? null,
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
  const priceAmount = dto.priceAmount;
  if (!Number.isInteger(priceAmount) || priceAmount <= 0) {
    throw new BadRequestException('priceAmount must be a positive integer');
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
