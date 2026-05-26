import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProviderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProviderDto, ProviderServiceAreaDto } from './dto/create-provider.dto';
import { UpdateProviderStatusDto } from './dto/update-provider-status.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';

type ProviderListFilters = {
  status?: string;
  city?: string;
  categoryId?: string;
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
