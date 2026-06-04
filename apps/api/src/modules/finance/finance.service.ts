import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CreditTransactionType,
  PackagePurchaseStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';

const RECENT_TRANSACTIONS_LIMIT = 10;
const RECENT_PURCHASES_LIMIT = 5;
const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGE_SIZE = 200;

type CreditTotals = Record<CreditTransactionType, number>;
type PurchaseCounts = Record<PackagePurchaseStatus, number>;

@Injectable()
export class FinanceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async summary() {
    const now = new Date();
    const todayStart = startOfIstanbulDay(now);
    const monthStart = startOfIstanbulMonth(now);

    const [
      revenueTotalAgg,
      revenueTodayAgg,
      revenueMonthAgg,
      packageStatusGroups,
      creditTypeGroups,
      activeBalance,
      recentTransactions,
      recentPurchases,
    ] = await Promise.all([
      this.prisma.packagePurchase.aggregate({
        where: { status: PackagePurchaseStatus.PAID },
        _sum: { priceAmountSnapshot: true },
      }),
      this.prisma.packagePurchase.aggregate({
        where: {
          status: PackagePurchaseStatus.PAID,
          paidAt: { gte: todayStart },
        },
        _sum: { priceAmountSnapshot: true },
      }),
      this.prisma.packagePurchase.aggregate({
        where: {
          status: PackagePurchaseStatus.PAID,
          paidAt: { gte: monthStart },
        },
        _sum: { priceAmountSnapshot: true },
      }),
      this.prisma.packagePurchase.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.providerCreditTransaction.groupBy({
        by: ['type'],
        _sum: { amount: true },
      }),
      this.computeActiveProviderCreditBalance(),
      this.prisma.providerCreditTransaction.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_TRANSACTIONS_LIMIT,
        include: {
          provider: {
            select: { id: true, businessName: true },
          },
          createdBy: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
      this.prisma.packagePurchase.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_PURCHASES_LIMIT,
        include: {
          provider: {
            select: { id: true, businessName: true },
          },
          package: {
            select: { id: true, name: true },
          },
        },
      }),
    ]);

    const purchaseCounts = toPurchaseCounts(packageStatusGroups);
    const creditTotals = toCreditTotals(creditTypeGroups);

    const totalPackagePurchases = Object.values(purchaseCounts).reduce(
      (sum, value) => sum + value,
      0,
    );

    return {
      revenue: {
        totalRevenuePaid: revenueTotalAgg._sum.priceAmountSnapshot ?? 0,
        todayRevenuePaid: revenueTodayAgg._sum.priceAmountSnapshot ?? 0,
        monthRevenuePaid: revenueMonthAgg._sum.priceAmountSnapshot ?? 0,
      },
      packagePurchases: {
        totalPackagePurchases,
        paidPackagePurchases: purchaseCounts[PackagePurchaseStatus.PAID],
        pendingPackagePurchases: purchaseCounts[PackagePurchaseStatus.PENDING],
        cancelledPackagePurchases:
          purchaseCounts[PackagePurchaseStatus.CANCELLED],
        failedPackagePurchases: purchaseCounts[PackagePurchaseStatus.FAILED],
        expiredPackagePurchases: purchaseCounts[PackagePurchaseStatus.EXPIRED],
        refundedPackagePurchases:
          purchaseCounts[PackagePurchaseStatus.REFUNDED],
      },
      credits: {
        totalCreditsSold: creditTotals[CreditTransactionType.PACKAGE_PURCHASE],
        totalCreditsSpent: Math.abs(
          creditTotals[CreditTransactionType.OFFER_SPEND],
        ),
        totalCreditsRefunded: creditTotals[CreditTransactionType.OFFER_REFUND],
        totalCreditsAdminGranted:
          creditTotals[CreditTransactionType.ADMIN_GRANT],
        totalCreditsAdminDeducted: Math.abs(
          creditTotals[CreditTransactionType.ADMIN_DEDUCT],
        ),
        totalCreditsAdjusted: creditTotals[CreditTransactionType.ADJUSTMENT],
        totalActiveProviderCreditBalance: activeBalance,
      },
      recentTransactions,
      recentPurchases,
    };
  }

  async listCreditLedger(filters: ListCreditLedgerDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);

    const where = buildCreditLedgerWhere(filters);

    const [total, rows] = await Promise.all([
      this.prisma.providerCreditTransaction.count({ where }),
      this.prisma.providerCreditTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          provider: {
            select: {
              id: true,
              businessName: true,
              phone: true,
              email: true,
            },
          },
          createdBy: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      type: row.type,
      amount: row.amount,
      balanceAfter: row.balanceAfter,
      previousBalance: row.balanceAfter - row.amount,
      reason: row.reason,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      provider: row.provider,
      createdBy: row.createdBy,
    }));

    const hasNextPage = page * pageSize < total;

    return {
      items,
      total,
      page,
      pageSize,
      hasNextPage,
    };
  }

  private async computeActiveProviderCreditBalance(): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      { balance_after: number | bigint }[]
    >(Prisma.sql`
      SELECT DISTINCT ON ("providerId") "balanceAfter" AS balance_after
      FROM "ProviderCreditTransaction"
      ORDER BY "providerId", "createdAt" DESC, "id" DESC
    `);

    return rows.reduce((sum, row) => sum + Number(row.balance_after), 0);
  }
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_LEDGER_PAGE_SIZE);
}

function buildCreditLedgerWhere(
  filters: ListCreditLedgerDto,
): Prisma.ProviderCreditTransactionWhereInput {
  const where: Prisma.ProviderCreditTransactionWhereInput = {};

  if (filters.providerId) {
    where.providerId = filters.providerId;
  }

  if (filters.type && filters.type.length > 0) {
    where.type = filters.type.length === 1
      ? filters.type[0]
      : { in: filters.type };
  }

  if (filters.referenceType) {
    where.referenceType = filters.referenceType;
  }

  const createdAt = buildCreatedAtRange(filters.from, filters.to);
  if (createdAt) {
    where.createdAt = createdAt;
  }

  if (filters.q) {
    const term = filters.q;
    where.OR = [
      { reason: { contains: term, mode: 'insensitive' } },
      {
        provider: {
          is: {
            OR: [
              { businessName: { contains: term, mode: 'insensitive' } },
              { phone: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          },
        },
      },
    ];
  }

  return where;
}

function buildCreatedAtRange(
  from: string | undefined,
  to: string | undefined,
): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};

  if (from) {
    const fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      throw new BadRequestException('Invalid "from" date');
    }
    range.gte = fromDate;
  }

  if (to) {
    const toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid "to" date');
    }
    range.lte = toDate;
  }

  if (range.gte === undefined && range.lte === undefined) {
    return undefined;
  }

  return range;
}

function toPurchaseCounts(
  groups: { status: PackagePurchaseStatus; _count: { _all: number } }[],
): PurchaseCounts {
  const counts: PurchaseCounts = {
    [PackagePurchaseStatus.PENDING]: 0,
    [PackagePurchaseStatus.PAID]: 0,
    [PackagePurchaseStatus.FAILED]: 0,
    [PackagePurchaseStatus.CANCELLED]: 0,
    [PackagePurchaseStatus.EXPIRED]: 0,
    [PackagePurchaseStatus.REFUNDED]: 0,
  };

  for (const group of groups) {
    counts[group.status] = group._count._all;
  }

  return counts;
}

function toCreditTotals(
  groups: { type: CreditTransactionType; _sum: { amount: number | null } }[],
): CreditTotals {
  const totals: CreditTotals = {
    [CreditTransactionType.ADMIN_GRANT]: 0,
    [CreditTransactionType.ADMIN_DEDUCT]: 0,
    [CreditTransactionType.PACKAGE_PURCHASE]: 0,
    [CreditTransactionType.OFFER_SPEND]: 0,
    [CreditTransactionType.OFFER_REFUND]: 0,
    [CreditTransactionType.ADJUSTMENT]: 0,
  };

  for (const group of groups) {
    totals[group.type] = group._sum.amount ?? 0;
  }

  return totals;
}

// Europe/Istanbul gün başlangıcı. Türkiye 2016'dan beri DST uygulamıyor (sabit UTC+3),
// fakat doğru tarafa düşmesi için Intl ile o anki Istanbul takvim gününü çıkarıp
// `+03:00` ofsetiyle birleştiriyoruz.
function startOfIstanbulDay(now: Date): Date {
  const parts = istanbulDateParts(now);
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+03:00`);
}

function startOfIstanbulMonth(now: Date): Date {
  const parts = istanbulDateParts(now);
  return new Date(`${parts.year}-${parts.month}-01T00:00:00+03:00`);
}

function istanbulDateParts(now: Date): {
  year: string;
  month: string;
  day: string;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const formatted = formatter.format(now);
  const [year = '1970', month = '01', day = '01'] = formatted.split('-');
  return { year, month, day };
}
