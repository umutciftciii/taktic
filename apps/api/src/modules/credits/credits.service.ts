import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCreditPackageDto } from './dto/create-credit-package.dto';
import { ManualCreditTransactionDto } from './dto/manual-credit-transaction.dto';
import { UpdateCreditPackageDto } from './dto/update-credit-package.dto';

type CreditTransactionInput = {
  providerId: string;
  type: CreditTransactionType;
  amount: number;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  createdById?: string | null;
};

@Injectable()
export class CreditsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listCreditPackages(includeInactive: boolean) {
    return this.prisma.offerCreditPackage.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCreditPackage(dto: CreateCreditPackageDto) {
    try {
      return await this.prisma.offerCreditPackage.create({
        data: creditPackageCreatePayload(dto),
      });
    } catch (error) {
      handleCreditPackageWriteError(error);
    }
  }

  async updateCreditPackage(id: string, dto: UpdateCreditPackageDto) {
    await this.ensureCreditPackageExists(id);

    try {
      return await this.prisma.offerCreditPackage.update({
        where: { id },
        data: creditPackageUpdatePayload(dto),
      });
    } catch (error) {
      handleCreditPackageWriteError(error);
    }
  }

  async updateCreditPackageStatus(id: string, isActive: boolean) {
    await this.ensureCreditPackageExists(id);

    return this.prisma.offerCreditPackage.update({
      where: { id },
      data: { isActive },
    });
  }

  async getProviderCredits(providerId: string) {
    await this.ensureProviderExists(providerId);
    const [balance, transactions] = await Promise.all([
      this.getProviderCreditBalance(providerId),
      this.prisma.providerCreditTransaction.findMany({
        where: { providerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      providerId,
      balance,
      transactions,
    };
  }

  async listProviderCreditTransactions(providerId: string) {
    await this.ensureProviderExists(providerId);

    return this.prisma.providerCreditTransaction.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  grantCredits(providerId: string, dto: ManualCreditTransactionDto) {
    const amount = normalizePositiveAmount(dto.amount);

    return this.createProviderCreditTransaction({
      providerId,
      type: CreditTransactionType.ADMIN_GRANT,
      amount,
      reason: normalizeNullableString(dto.reason),
    });
  }

  deductCredits(providerId: string, dto: ManualCreditTransactionDto) {
    const amount = normalizePositiveAmount(dto.amount);

    return this.createProviderCreditTransaction({
      providerId,
      type: CreditTransactionType.ADMIN_DEDUCT,
      amount: -amount,
      reason: normalizeNullableString(dto.reason),
    });
  }

  async getProviderCreditBalance(providerId: string) {
    await this.ensureProviderExists(providerId);
    const latestTransaction = await this.prisma.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });

    return latestTransaction?.balanceAfter ?? 0;
  }

  async createProviderCreditTransaction(input: CreditTransactionInput) {
    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.providerProfile.findUnique({
        where: { id: input.providerId },
        select: { id: true },
      });

      if (!provider) {
        throw new NotFoundException('Provider not found');
      }

      const latestTransaction = await tx.providerCreditTransaction.findFirst({
        where: { providerId: input.providerId },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfter: true },
      });
      const currentBalance = latestTransaction?.balanceAfter ?? 0;
      const balanceAfter = currentBalance + input.amount;

      if (balanceAfter < 0) {
        throw new BadRequestException('Credit balance cannot go below zero');
      }

      return tx.providerCreditTransaction.create({
        data: {
          providerId: input.providerId,
          type: input.type,
          amount: input.amount,
          balanceAfter,
          reason: normalizeNullableString(input.reason),
          referenceType: normalizeNullableString(input.referenceType),
          referenceId: normalizeNullableString(input.referenceId),
          createdById: normalizeNullableString(input.createdById),
        },
      });
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

  private async ensureCreditPackageExists(id: string) {
    const creditPackage = await this.prisma.offerCreditPackage.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!creditPackage) {
      throw new NotFoundException('Credit package not found');
    }
  }
}

function creditPackageCreatePayload(dto: CreateCreditPackageDto) {
  return {
    name: normalizeRequiredString(dto.name, 'Credit package name'),
    slug: normalizeSlug(dto.slug),
    creditAmount: normalizePositiveAmount(dto.creditAmount),
    priceAmount: normalizePositiveAmount(dto.priceAmount),
    currency: normalizeNullableString(dto.currency) ?? 'TRY',
    description: normalizeNullableString(dto.description),
    isActive: dto.isActive ?? true,
    sortOrder: dto.sortOrder ?? 0,
  };
}

function creditPackageUpdatePayload(dto: UpdateCreditPackageDto) {
  return {
    ...(dto.name !== undefined
      ? { name: normalizeRequiredString(dto.name, 'Credit package name') }
      : {}),
    ...(dto.slug !== undefined ? { slug: normalizeSlug(dto.slug) } : {}),
    ...(dto.creditAmount !== undefined ? { creditAmount: normalizePositiveAmount(dto.creditAmount) } : {}),
    ...(dto.priceAmount !== undefined ? { priceAmount: normalizePositiveAmount(dto.priceAmount) } : {}),
    ...(dto.currency !== undefined ? { currency: normalizeNullableString(dto.currency) ?? 'TRY' } : {}),
    ...(dto.description !== undefined ? { description: normalizeNullableString(dto.description) } : {}),
    ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
  };
}

function normalizePositiveAmount(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException('Amount must be a positive integer');
  }

  return value;
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

function normalizeSlug(value: string) {
  const slug = normalizeRequiredString(value, 'Credit package slug');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new BadRequestException('Credit package slug must be lowercase and URL-safe');
  }

  return slug;
}

function handleCreditPackageWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException('Credit package slug already exists');
  }

  throw error;
}
