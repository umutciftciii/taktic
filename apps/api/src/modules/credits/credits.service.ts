import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  OfferPackageType,
  Prisma,
  ServiceCategoryStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PACKAGE_PERIOD_DAYS } from '../entitlements/entitlement-period';
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

type CreditTransactionTx = Prisma.TransactionClient;

@Injectable()
export class CreditsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The credit-package listing, unchanged in every respect that a caller can
   * observe — including that it answers unauthenticated callers.
   *
   * Narrowed to ONE_TIME_CREDITS, which is exactly what this endpoint could
   * ever return before period packages existed. That is not a filter added on
   * top of the old behaviour, it *is* the old behaviour: a monthly quota's size
   * and an unlimited package's category scope say what a provider's commercial
   * position looks like, and this route has no authentication to protect it
   * with. Providers read the full catalogue from
   * `GET /providers/:providerId/offer-packages`, behind their own guard.
   *
   * `includeInactive` (SUPER_ADMIN only, enforced in the controller) widens the
   * status filter and nothing else; the admin package screens read every type
   * through {@link listAllPackagesForAdmin}.
   */
  listCreditPackages(includeInactive: boolean) {
    return this.prisma.offerCreditPackage.findMany({
      where: {
        type: OfferPackageType.ONE_TIME_CREDITS,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      // Spelled out rather than "every scalar", so the public response is the
      // one it has always been. Without this, adding a column to the table
      // publishes it: `quotaCredits`, `periodDays` and `dailyOfferLimit` would
      // have appeared on an unauthenticated endpoint the day the migration ran,
      // and the next column would too.
      select: publicCreditPackageSelect,
    });
  }

  /** Every package of every type, with its scope. SUPER_ADMIN only. */
  listAllPackagesForAdmin(includeInactive: boolean) {
    return this.prisma.offerCreditPackage.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: adminPackageInclude,
    });
  }

  async getPackageForAdmin(id: string) {
    const found = await this.prisma.offerCreditPackage.findUnique({
      where: { id },
      include: adminPackageInclude,
    });

    if (!found) {
      throw new NotFoundException('Credit package not found');
    }

    return found;
  }

  /**
   * The categories an admin has opened up for unlimited packages, which is the
   * only pool a CATEGORY_UNLIMITED scope may be drawn from.
   *
   * INACTIVE categories are left out: they accept no new offers at all, so
   * selling unmetered offering on one would be selling nothing.
   */
  listUnlimitedEligibleCategories() {
    return this.prisma.serviceCategory.findMany({
      where: {
        unlimitedPackageEligible: true,
        status: { not: ServiceCategoryStatus.INACTIVE },
      },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, kind: true, status: true, parentId: true },
    });
  }

  async createCreditPackage(dto: CreateCreditPackageDto) {
    const type = dto.type ?? OfferPackageType.ONE_TIME_CREDITS;
    const scopeCategoryIds = await this.readScopeSelection(type, dto.scopeCategoryIds);

    try {
      return await this.prisma.offerCreditPackage.create({
        data: {
          ...creditPackageCreatePayload(dto, type),
          ...(scopeCategoryIds.length > 0
            ? {
                scopeCategories: {
                  create: scopeCategoryIds.map((categoryId) => ({ categoryId })),
                },
              }
            : {}),
        },
        include: adminPackageInclude,
      });
    } catch (error) {
      handleCreditPackageWriteError(error);
    }
  }

  async updateCreditPackage(id: string, dto: UpdateCreditPackageDto) {
    const existing = await this.prisma.offerCreditPackage.findUnique({
      where: { id },
      select: { id: true, type: true },
    });

    if (!existing) {
      throw new NotFoundException('Credit package not found');
    }

    // Undefined means "leave the scope alone"; an explicit array replaces it.
    const scopeCategoryIds =
      dto.scopeCategoryIds === undefined
        ? null
        : await this.readScopeSelection(existing.type, dto.scopeCategoryIds);

    try {
      return await this.prisma.offerCreditPackage.update({
        where: { id },
        data: {
          ...creditPackageUpdatePayload(dto, existing.type),
          ...(scopeCategoryIds === null
            ? {}
            : {
                // Replaced wholesale. Every entitlement already sold carries its
                // own frozen copy of the old scope, so rewriting this one cannot
                // reach a period somebody has paid for.
                scopeCategories: {
                  deleteMany: {},
                  create: scopeCategoryIds.map((categoryId) => ({ categoryId })),
                },
              }),
        },
        include: adminPackageInclude,
      });
    } catch (error) {
      handleCreditPackageWriteError(error);
    }
  }

  /**
   * Validates a CATEGORY_UNLIMITED scope against the eligibility flag.
   *
   * This is where "regulated or high-value categories are not sold unmetered by
   * default" is actually enforced. Eligibility defaults to false for every
   * category that exists and every category the taxonomy import will ever
   * create, so a category nobody has deliberately opened up cannot end up in a
   * package's scope — not by a typo, not by a copied payload, and not by an
   * import that added a hundred new leaves overnight.
   *
   * INACTIVE categories are refused too: they accept no offers at all, so
   * selling unlimited offering on one would be selling nothing.
   */
  private async readScopeSelection(
    type: OfferPackageType,
    scopeCategoryIds: string[] | undefined,
  ): Promise<string[]> {
    const requested = [...new Set(scopeCategoryIds ?? [])];

    if (type !== OfferPackageType.CATEGORY_UNLIMITED) {
      if (requested.length > 0) {
        throw new BadRequestException(
          'Kategori kapsamı yalnızca CATEGORY_UNLIMITED paketlerde tanımlanabilir',
        );
      }

      return [];
    }

    if (requested.length === 0) {
      throw new BadRequestException(
        'CATEGORY_UNLIMITED paketi için en az bir kategori veya kategori grubu seçilmelidir',
      );
    }

    const found = await this.prisma.serviceCategory.findMany({
      where: { id: { in: requested } },
      select: { id: true, name: true, status: true, unlimitedPackageEligible: true },
    });

    if (found.length !== requested.length) {
      throw new BadRequestException('Seçilen kategorilerden biri bulunamadı');
    }

    const refused = found.filter(
      (category) =>
        !category.unlimitedPackageEligible ||
        category.status === ServiceCategoryStatus.INACTIVE,
    );

    if (refused.length > 0) {
      throw new BadRequestException(
        `Şu kategoriler limitsiz paket kapsamına alınamaz: ${refused
          .map((category) => category.name)
          .join(', ')}. Önce kategori yönetiminden limitsiz paket uygunluğunu açın.`,
      );
    }

    return requested;
  }

  async updateCreditPackageStatus(id: string, isActive: boolean) {
    await this.ensureCreditPackageExists(id);

    return this.prisma.offerCreditPackage.update({
      where: { id },
      data: { isActive },
    });
  }

  async getProviderCredits(providerId: string, options: { includeActor?: boolean } = {}) {
    await this.ensureProviderExists(providerId);
    const [balance, transactions] = await Promise.all([
      this.getProviderCreditBalance(providerId),
      this.prisma.providerCreditTransaction.findMany({
        where: { providerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        ...(options.includeActor
          ? { include: { createdBy: { select: { id: true, name: true, email: true } } } }
          : {}),
      }),
    ]);

    return {
      providerId,
      balance,
      transactions,
    };
  }

  async listProviderCreditTransactions(
    providerId: string,
    options: { includeActor?: boolean } = {},
  ) {
    await this.ensureProviderExists(providerId);

    return this.prisma.providerCreditTransaction.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(options.includeActor
        ? { include: { createdBy: { select: { id: true, name: true, email: true } } } }
        : {}),
    });
  }

  grantCredits(providerId: string, dto: ManualCreditTransactionDto, createdById: string) {
    const amount = normalizePositiveAmount(dto.amount);
    const reason = normalizeRequiredReason(dto.reason);

    return this.createProviderCreditTransaction({
      providerId,
      type: CreditTransactionType.ADMIN_GRANT,
      amount,
      reason,
      createdById,
    });
  }

  deductCredits(providerId: string, dto: ManualCreditTransactionDto, createdById: string) {
    const amount = normalizePositiveAmount(dto.amount);
    const reason = normalizeRequiredReason(dto.reason);

    return this.createProviderCreditTransaction({
      providerId,
      type: CreditTransactionType.ADMIN_DEDUCT,
      amount: -amount,
      reason,
      createdById,
    });
  }

  async getProviderCreditBalance(providerId: string) {
    await this.ensureProviderExists(providerId);
    const latestTransaction = await this.prisma.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true },
    });

    return latestTransaction?.balanceAfter ?? 0;
  }

  async createProviderCreditTransaction(input: CreditTransactionInput) {
    return this.prisma.$transaction(
      async (tx) => this.createProviderCreditTransactionInTransaction(tx, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async createProviderCreditTransactionInTransaction(tx: CreditTransactionTx, input: CreditTransactionInput) {
    const provider = await tx.providerProfile.findUnique({
      where: { id: input.providerId },
      select: { id: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    const latestTransaction = await tx.providerCreditTransaction.findFirst({
      where: { providerId: input.providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

/** Exactly the columns `GET /credit-packages` returned before period packages. */
const publicCreditPackageSelect = {
  id: true,
  name: true,
  slug: true,
  creditAmount: true,
  priceAmount: true,
  currency: true,
  description: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OfferCreditPackageSelect;

const adminPackageInclude = {
  scopeCategories: {
    select: {
      category: { select: { id: true, name: true, slug: true, kind: true, status: true } },
    },
    orderBy: { category: { name: 'asc' } },
  },
} satisfies Prisma.OfferCreditPackageInclude;

/**
 * The per-type field rules, in the shape the database CHECK also states.
 *
 * Kept in both places deliberately: the service refuses with a message an admin
 * can act on, and the constraint makes the invalid row unrepresentable however
 * it was attempted.
 */
function creditPackageCreatePayload(dto: CreateCreditPackageDto, type: OfferPackageType) {
  return {
    name: normalizeRequiredString(dto.name, 'Credit package name'),
    slug: normalizeSlug(dto.slug),
    type,
    priceAmount: normalizePriceMinor(dto.priceAmount, 'priceAmount'),
    currency: normalizeNullableString(dto.currency) ?? 'TRY',
    description: normalizeNullableString(dto.description),
    isActive: dto.isActive ?? true,
    sortOrder: dto.sortOrder ?? 0,
    ...typeSpecificPayload(type, dto),
  };
}

function creditPackageUpdatePayload(dto: UpdateCreditPackageDto, type: OfferPackageType) {
  return {
    ...(dto.name !== undefined
      ? { name: normalizeRequiredString(dto.name, 'Credit package name') }
      : {}),
    ...(dto.slug !== undefined ? { slug: normalizeSlug(dto.slug) } : {}),
    ...(dto.priceAmount !== undefined
      ? { priceAmount: normalizePriceMinor(dto.priceAmount, 'priceAmount') }
      : {}),
    ...(dto.currency !== undefined ? { currency: normalizeNullableString(dto.currency) ?? 'TRY' } : {}),
    ...(dto.description !== undefined ? { description: normalizeNullableString(dto.description) } : {}),
    ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    ...(type === OfferPackageType.ONE_TIME_CREDITS
      ? dto.creditAmount !== undefined
        ? { creditAmount: normalizePositiveCount(dto.creditAmount, 'creditAmount') }
        : {}
      : {}),
    ...(type === OfferPackageType.MONTHLY_QUOTA && dto.quotaCredits !== undefined
      ? { quotaCredits: normalizePositiveCount(dto.quotaCredits, 'quotaCredits') }
      : {}),
    ...(type === OfferPackageType.CATEGORY_UNLIMITED && dto.dailyOfferLimit !== undefined
      ? {
          dailyOfferLimit:
            dto.dailyOfferLimit === null
              ? null
              : normalizePositiveCount(dto.dailyOfferLimit, 'dailyOfferLimit'),
        }
      : {}),
  };
}

function typeSpecificPayload(type: OfferPackageType, dto: CreateCreditPackageDto) {
  if (type === OfferPackageType.ONE_TIME_CREDITS) {
    if (dto.quotaCredits !== undefined || dto.dailyOfferLimit !== undefined) {
      throw new BadRequestException(
        'Tek seferlik kredi paketinde kota veya günlük teklif limiti tanımlanamaz',
      );
    }

    return {
      creditAmount: normalizePositiveCount(dto.creditAmount ?? 0, 'creditAmount'),
      quotaCredits: null,
      periodDays: null,
      dailyOfferLimit: null,
    };
  }

  if (dto.creditAmount !== undefined && dto.creditAmount !== 0) {
    throw new BadRequestException(
      'Dönemsel paketler kredi bakiyesi yüklemez; creditAmount 0 olmalıdır',
    );
  }

  if (type === OfferPackageType.MONTHLY_QUOTA) {
    if (dto.dailyOfferLimit !== undefined && dto.dailyOfferLimit !== null) {
      throw new BadRequestException('Aylık kota paketinde günlük teklif limiti tanımlanmaz');
    }

    return {
      creditAmount: 0,
      quotaCredits: normalizePositiveCount(dto.quotaCredits ?? 0, 'quotaCredits'),
      // Written by the server, never by the payload: the product is a 30-day
      // period, and an endpoint that let a caller choose the length would be an
      // endpoint that can sell a different product than the one on the screen.
      periodDays: PACKAGE_PERIOD_DAYS,
      dailyOfferLimit: null,
    };
  }

  if (dto.quotaCredits !== undefined) {
    throw new BadRequestException('Limitsiz pakette kota tanımlanamaz');
  }

  return {
    creditAmount: 0,
    quotaCredits: null,
    periodDays: PACKAGE_PERIOD_DAYS,
    dailyOfferLimit:
      dto.dailyOfferLimit === undefined || dto.dailyOfferLimit === null
        ? null
        : normalizePositiveCount(dto.dailyOfferLimit, 'dailyOfferLimit'),
  };
}

// Used for credit counts and other non-monetary positive integers.
function normalizePositiveCount(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`${fieldName} must be a positive integer`);
  }

  return value;
}

// Monetary amounts are stored in minor units (e.g. kuruş for TRY). The smallest
// acceptable value is 100 = one whole currency unit (1,00 TRY / $1.00 / 1,00 €).
function normalizePriceMinor(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 100) {
    throw new BadRequestException(
      `${fieldName} must be a positive integer in minor units (kuruş) and at least 100 (1,00).`,
    );
  }

  return value;
}

// Kept for backwards compatibility with callers that pass non-monetary amounts.
function normalizePositiveAmount(value: number) {
  return normalizePositiveCount(value, 'Amount');
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

function normalizeRequiredReason(value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException('Reason is required');
  }

  const trimmed = value.trim();
  if (trimmed.length < 3) {
    throw new BadRequestException('Reason must be at least 3 characters');
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
