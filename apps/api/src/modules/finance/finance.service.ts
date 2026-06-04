import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CreditTransactionType,
  PackagePurchaseStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FinanceAnalyticsDto,
  FinanceAnalyticsGroupBy,
} from './dto/finance-analytics.dto';
import { ListCreditLedgerDto } from './dto/list-credit-ledger.dto';
import {
  ListProviderFinanceDto,
  ProviderFinanceSortField,
} from './dto/list-provider-finance.dto';

const RECENT_TRANSACTIONS_LIMIT = 10;
const RECENT_PURCHASES_LIMIT = 5;
const DEFAULT_LEDGER_PAGE_SIZE = 50;
const MAX_LEDGER_PAGE_SIZE = 200;
const DEFAULT_PROVIDER_FINANCE_PAGE_SIZE = 25;
const MAX_PROVIDER_FINANCE_PAGE_SIZE = 100;

const ISTANBUL_TZ_OFFSET = '+03:00';
const ANALYTICS_DEFAULT_RANGE_DAYS = 30;
const ANALYTICS_BUCKET_LIMITS: Record<FinanceAnalyticsGroupBy, number> = {
  day: 370,
  month: 60,
  year: 10,
};
const ANALYTICS_TRACKED_CREDIT_TYPES: CreditTransactionType[] = [
  CreditTransactionType.PACKAGE_PURCHASE,
  CreditTransactionType.OFFER_SPEND,
  CreditTransactionType.OFFER_REFUND,
  CreditTransactionType.ADMIN_GRANT,
  CreditTransactionType.ADMIN_DEDUCT,
];

type AnalyticsAccumulator = {
  paidRevenue: number;
  paidPackageCount: number;
  soldCredits: number;
  spentCredits: number;
  refundedCredits: number;
  adminGrantedCredits: number;
  adminDeductedCredits: number;
};

type AnalyticsBucketDescriptor = {
  key: string;
  label: string;
  start: Date;
  end: Date;
};

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

  async analytics(filters: FinanceAnalyticsDto) {
    const groupBy = normalizeAnalyticsGroupBy(filters.groupBy);

    if (filters.from !== undefined && !isValidIsoDate(filters.from)) {
      throw new BadRequestException('"from" must be in YYYY-MM-DD format');
    }
    if (filters.to !== undefined && !isValidIsoDate(filters.to)) {
      throw new BadRequestException('"to" must be in YYYY-MM-DD format');
    }

    const { fromDate, toDate } = resolveAnalyticsRange(filters.from, filters.to);

    if (fromDate > toDate) {
      throw new BadRequestException('"from" must be on or before "to"');
    }

    const bucketLimit = ANALYTICS_BUCKET_LIMITS[groupBy];
    const estimatedBuckets = estimateAnalyticsBucketCount(
      fromDate,
      toDate,
      groupBy,
    );
    if (estimatedBuckets > bucketLimit) {
      throw new BadRequestException(
        `Range too large for groupBy=${groupBy} (max ${bucketLimit} buckets, requested ${estimatedBuckets})`,
      );
    }

    const fromInstant = parseIstanbulDayStart(fromDate);
    const toInstant = parseIstanbulDayEnd(toDate);

    const buckets = generateAnalyticsBuckets(fromDate, toDate, groupBy);

    const [purchases, transactions] = await Promise.all([
      this.prisma.packagePurchase.findMany({
        where: {
          status: PackagePurchaseStatus.PAID,
          paidAt: { gte: fromInstant, lte: toInstant },
        },
        select: { paidAt: true, priceAmountSnapshot: true },
      }),
      this.prisma.providerCreditTransaction.findMany({
        where: {
          createdAt: { gte: fromInstant, lte: toInstant },
          type: { in: ANALYTICS_TRACKED_CREDIT_TYPES },
        },
        select: { createdAt: true, type: true, amount: true },
      }),
    ]);

    const bucketMap = new Map<string, AnalyticsAccumulator>();
    for (const bucket of buckets) {
      bucketMap.set(bucket.key, createEmptyAnalyticsAccumulator());
    }

    for (const purchase of purchases) {
      if (!purchase.paidAt) continue;
      const key = computeAnalyticsBucketKey(purchase.paidAt, groupBy);
      const acc = bucketMap.get(key);
      if (!acc) continue;
      acc.paidRevenue += purchase.priceAmountSnapshot;
      acc.paidPackageCount += 1;
    }

    for (const transaction of transactions) {
      const key = computeAnalyticsBucketKey(transaction.createdAt, groupBy);
      const acc = bucketMap.get(key);
      if (!acc) continue;
      switch (transaction.type) {
        case CreditTransactionType.PACKAGE_PURCHASE:
          acc.soldCredits += transaction.amount;
          break;
        case CreditTransactionType.OFFER_SPEND:
          acc.spentCredits += Math.abs(transaction.amount);
          break;
        case CreditTransactionType.OFFER_REFUND:
          acc.refundedCredits += transaction.amount;
          break;
        case CreditTransactionType.ADMIN_GRANT:
          acc.adminGrantedCredits += transaction.amount;
          break;
        case CreditTransactionType.ADMIN_DEDUCT:
          acc.adminDeductedCredits += Math.abs(transaction.amount);
          break;
        default:
          break;
      }
    }

    const totals = createEmptyAnalyticsAccumulator();
    const bucketsOut = buckets.map((bucket) => {
      const acc = bucketMap.get(bucket.key) ?? createEmptyAnalyticsAccumulator();
      totals.paidRevenue += acc.paidRevenue;
      totals.paidPackageCount += acc.paidPackageCount;
      totals.soldCredits += acc.soldCredits;
      totals.spentCredits += acc.spentCredits;
      totals.refundedCredits += acc.refundedCredits;
      totals.adminGrantedCredits += acc.adminGrantedCredits;
      totals.adminDeductedCredits += acc.adminDeductedCredits;
      return {
        key: bucket.key,
        label: bucket.label,
        start: bucket.start.toISOString(),
        end: bucket.end.toISOString(),
        paidRevenue: acc.paidRevenue,
        paidPackageCount: acc.paidPackageCount,
        soldCredits: acc.soldCredits,
        spentCredits: acc.spentCredits,
        refundedCredits: acc.refundedCredits,
        adminGrantedCredits: acc.adminGrantedCredits,
        adminDeductedCredits: acc.adminDeductedCredits,
      };
    });

    return {
      range: { from: fromDate, to: toDate, groupBy },
      totals,
      buckets: bucketsOut,
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

  async listProviderFinance(filters: ListProviderFinanceDto) {
    const page = filters.page ?? 1;
    const pageSize = clampProviderFinancePageSize(filters.pageSize);
    const sortBy: ProviderFinanceSortField = filters.sortBy ?? 'lastTransactionAt';
    const sortDir: 'asc' | 'desc' = filters.sortDir ?? 'desc';

    const providerWhere = buildProviderFinanceWhere(filters);

    const providers = await this.prisma.providerProfile.findMany({
      where: providerWhere,
      select: {
        id: true,
        businessName: true,
        phone: true,
        email: true,
        status: true,
      },
    });

    const total = providers.length;
    const providerIds = providers.map((row) => row.id);

    const [creditByType, packagePaid, lastTxn, balances] =
      providerIds.length === 0
        ? ([[], [], [], []] as const)
        : await Promise.all([
            this.prisma.providerCreditTransaction.groupBy({
              by: ['providerId', 'type'],
              _sum: { amount: true },
              where: { providerId: { in: providerIds } },
            }),
            this.prisma.packagePurchase.groupBy({
              by: ['providerId'],
              _sum: { priceAmountSnapshot: true },
              _max: { paidAt: true },
              where: {
                providerId: { in: providerIds },
                status: PackagePurchaseStatus.PAID,
              },
            }),
            this.prisma.providerCreditTransaction.groupBy({
              by: ['providerId'],
              _max: { createdAt: true },
              where: { providerId: { in: providerIds } },
            }),
            this.prisma.$queryRaw<
              { providerId: string; balanceAfter: number | bigint }[]
            >(Prisma.sql`
              SELECT DISTINCT ON ("providerId") "providerId", "balanceAfter"
              FROM "ProviderCreditTransaction"
              WHERE "providerId" IN (${Prisma.join(providerIds)})
              ORDER BY "providerId", "createdAt" DESC, "id" DESC
            `),
          ]);

    const creditSumByProvider = new Map<string, Record<CreditTransactionType, number>>();
    for (const row of creditByType) {
      const totals =
        creditSumByProvider.get(row.providerId) ?? createEmptyCreditTotals();
      totals[row.type] = row._sum.amount ?? 0;
      creditSumByProvider.set(row.providerId, totals);
    }

    const paidByProvider = new Map<
      string,
      { totalPaid: number; lastPaidAt: Date | null }
    >();
    for (const row of packagePaid) {
      paidByProvider.set(row.providerId, {
        totalPaid: row._sum.priceAmountSnapshot ?? 0,
        lastPaidAt: row._max.paidAt ?? null,
      });
    }

    const lastTxnByProvider = new Map<string, Date | null>();
    for (const row of lastTxn) {
      lastTxnByProvider.set(row.providerId, row._max.createdAt ?? null);
    }

    const balanceByProvider = new Map<string, number>();
    for (const row of balances) {
      balanceByProvider.set(row.providerId, Number(row.balanceAfter));
    }

    const items = providers.map((provider) => {
      const totals =
        creditSumByProvider.get(provider.id) ?? createEmptyCreditTotals();
      const paid = paidByProvider.get(provider.id);

      const totalCreditsPurchased = totals[CreditTransactionType.PACKAGE_PURCHASE];
      const totalCreditsSpent = Math.abs(totals[CreditTransactionType.OFFER_SPEND]);
      const totalCreditsRefunded = totals[CreditTransactionType.OFFER_REFUND];
      const totalCreditsAdminGranted = totals[CreditTransactionType.ADMIN_GRANT];
      const totalCreditsAdminDeducted = Math.abs(
        totals[CreditTransactionType.ADMIN_DEDUCT],
      );
      const totalCreditsAdjusted = totals[CreditTransactionType.ADJUSTMENT];
      const manualNetCredits =
        totals[CreditTransactionType.ADMIN_GRANT] +
        totals[CreditTransactionType.ADMIN_DEDUCT];

      return {
        provider: {
          id: provider.id,
          businessName: provider.businessName,
          phone: provider.phone,
          email: provider.email,
          status: provider.status,
        },
        currentBalance: balanceByProvider.get(provider.id) ?? 0,
        totalPaidAmount: paid?.totalPaid ?? 0,
        totalCreditsPurchased,
        totalCreditsSpent,
        totalCreditsRefunded,
        totalCreditsAdminGranted,
        totalCreditsAdminDeducted,
        manualNetCredits,
        totalCreditsAdjusted,
        lastPaymentAt: paid?.lastPaidAt ?? null,
        lastTransactionAt: lastTxnByProvider.get(provider.id) ?? null,
      };
    });

    items.sort(buildProviderFinanceComparator(sortBy, sortDir));

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pagedItems = items.slice(start, end);
    const hasNextPage = end < total;

    return {
      items: pagedItems,
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

function clampProviderFinancePageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROVIDER_FINANCE_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PROVIDER_FINANCE_PAGE_SIZE);
}

function buildProviderFinanceWhere(
  filters: ListProviderFinanceDto,
): Prisma.ProviderProfileWhereInput {
  if (!filters.q) return {};
  const term = filters.q;
  return {
    OR: [
      { businessName: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ],
  };
}

function createEmptyCreditTotals(): Record<CreditTransactionType, number> {
  return {
    [CreditTransactionType.ADMIN_GRANT]: 0,
    [CreditTransactionType.ADMIN_DEDUCT]: 0,
    [CreditTransactionType.PACKAGE_PURCHASE]: 0,
    [CreditTransactionType.OFFER_SPEND]: 0,
    [CreditTransactionType.OFFER_REFUND]: 0,
    [CreditTransactionType.ADJUSTMENT]: 0,
  };
}

type ProviderFinanceItem = {
  provider: {
    id: string;
    businessName: string;
    phone: string;
    email: string | null;
    status: string;
  };
  currentBalance: number;
  totalPaidAmount: number;
  totalCreditsPurchased: number;
  totalCreditsSpent: number;
  totalCreditsRefunded: number;
  totalCreditsAdminGranted: number;
  totalCreditsAdminDeducted: number;
  manualNetCredits: number;
  totalCreditsAdjusted: number;
  lastPaymentAt: Date | null;
  lastTransactionAt: Date | null;
};

function buildProviderFinanceComparator(
  sortBy: ProviderFinanceSortField,
  sortDir: 'asc' | 'desc',
) {
  const direction = sortDir === 'desc' ? -1 : 1;
  return (a: ProviderFinanceItem, b: ProviderFinanceItem): number => {
    const cmp = compareProviderFinance(a, b, sortBy);
    if (cmp !== 0) return cmp * direction;
    // Stable tiebreaker so order is deterministic across queries.
    return a.provider.businessName.localeCompare(b.provider.businessName, 'tr');
  };
}

function compareProviderFinance(
  a: ProviderFinanceItem,
  b: ProviderFinanceItem,
  sortBy: ProviderFinanceSortField,
): number {
  switch (sortBy) {
    case 'businessName':
      return a.provider.businessName.localeCompare(b.provider.businessName, 'tr');
    case 'currentBalance':
      return a.currentBalance - b.currentBalance;
    case 'totalPaidAmount':
      return a.totalPaidAmount - b.totalPaidAmount;
    case 'totalCreditsPurchased':
      return a.totalCreditsPurchased - b.totalCreditsPurchased;
    case 'totalCreditsSpent':
      return a.totalCreditsSpent - b.totalCreditsSpent;
    case 'totalCreditsRefunded':
      return a.totalCreditsRefunded - b.totalCreditsRefunded;
    case 'manualNetCredits':
      return a.manualNetCredits - b.manualNetCredits;
    case 'lastPaymentAt':
      return compareNullableDates(a.lastPaymentAt, b.lastPaymentAt);
    case 'lastTransactionAt':
      return compareNullableDates(a.lastTransactionAt, b.lastTransactionAt);
    default:
      return 0;
  }
}

// Null/undefined dates always sort lowest so "desc" puts the freshest at the top
// and "asc" surfaces never-active providers first.
function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return 1;
  if (b) return -1;
  return 0;
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_LEDGER_PAGE_SIZE);
}

const KNOWN_CREDIT_TRANSACTION_TYPES = new Set<string>(
  Object.values(CreditTransactionType),
);

// Defensive normalizer for the ledger type filter. Accepts whatever shape
// reaches the service — single string, comma-separated string, repeated query
// array, or already-parsed enum array — and returns a clean enum array. Throws
// a 400 when an unknown enum value slips through (rather than letting Prisma
// return a 500 on validation failure).
function normalizeLedgerTypeFilter(
  raw: ListCreditLedgerDto['type'],
): CreditTransactionType[] {
  if (raw === undefined || raw === null) return [];

  const tokens: string[] = Array.isArray(raw)
    ? raw.flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  const cleaned = tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of cleaned) {
    if (!KNOWN_CREDIT_TRANSACTION_TYPES.has(token)) {
      throw new BadRequestException(`Invalid credit transaction type: ${token}`);
    }
  }

  return cleaned as CreditTransactionType[];
}

function buildCreditLedgerWhere(
  filters: ListCreditLedgerDto,
): Prisma.ProviderCreditTransactionWhereInput {
  const where: Prisma.ProviderCreditTransactionWhereInput = {};

  if (filters.providerId) {
    where.providerId = filters.providerId;
  }

  const types = normalizeLedgerTypeFilter(filters.type);
  if (types.length > 0) {
    where.type = types.length === 1 ? types[0] : { in: types };
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

// Defensive normalizer for the analytics groupBy. The DTO already restricts
// this via @IsIn, but Nest's query-string ValidationPipe behavior has historically
// let unexpected values through, so we re-check at the service boundary and
// return 400 rather than silently falling back.
function normalizeAnalyticsGroupBy(
  raw: FinanceAnalyticsGroupBy | undefined,
): FinanceAnalyticsGroupBy {
  if (raw === undefined) return 'day';
  if (raw === 'day' || raw === 'month' || raw === 'year') return raw;
  throw new BadRequestException(
    `Invalid groupBy: ${String(raw)} (expected day, month, or year)`,
  );
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const { year, month, day } = splitIsoDate(value);
  if (month < 1 || month > 12) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDay;
}

// Resolves the analytics date range. Both bounds are YYYY-MM-DD strings
// interpreted as Istanbul civil days. When neither is provided we return the
// last 30 calendar days ending today (inclusive); when only one is provided we
// align the other to the same day.
function resolveAnalyticsRange(
  fromInput: string | undefined,
  toInput: string | undefined,
): { fromDate: string; toDate: string } {
  if (fromInput && toInput) {
    return { fromDate: fromInput, toDate: toInput };
  }

  const todayParts = istanbulDateParts(new Date());
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;

  if (!fromInput && !toInput) {
    return {
      fromDate: addDaysToIsoDate(today, -(ANALYTICS_DEFAULT_RANGE_DAYS - 1)),
      toDate: today,
    };
  }

  if (fromInput && !toInput) {
    return { fromDate: fromInput, toDate: today };
  }

  // toInput only
  return {
    fromDate: addDaysToIsoDate(
      toInput as string,
      -(ANALYTICS_DEFAULT_RANGE_DAYS - 1),
    ),
    toDate: toInput as string,
  };
}

function parseIstanbulDayStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000${ISTANBUL_TZ_OFFSET}`);
}

function parseIstanbulDayEnd(isoDate: string): Date {
  return new Date(`${isoDate}T23:59:59.999${ISTANBUL_TZ_OFFSET}`);
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = splitIsoDate(isoDate);
  const t = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const d = new Date(t);
  return formatUtcAsIsoDate(d);
}

// Parses YYYY-MM-DD into numeric parts. The DTO regex guarantees this format
// reaches us, so any missing piece would mean a programmer error; falling back
// to epoch keeps TS happy without quietly accepting invalid input elsewhere.
function splitIsoDate(isoDate: string): {
  year: number;
  month: number;
  day: number;
} {
  const segments = isoDate.split('-');
  return {
    year: Number.parseInt(segments[0] ?? '1970', 10),
    month: Number.parseInt(segments[1] ?? '01', 10),
    day: Number.parseInt(segments[2] ?? '01', 10),
  };
}

function formatUtcAsIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createEmptyAnalyticsAccumulator(): AnalyticsAccumulator {
  return {
    paidRevenue: 0,
    paidPackageCount: 0,
    soldCredits: 0,
    spentCredits: 0,
    refundedCredits: 0,
    adminGrantedCredits: 0,
    adminDeductedCredits: 0,
  };
}

function estimateAnalyticsBucketCount(
  fromDate: string,
  toDate: string,
  groupBy: FinanceAnalyticsGroupBy,
): number {
  const from = splitIsoDate(fromDate);
  const to = splitIsoDate(toDate);

  switch (groupBy) {
    case 'day': {
      const diff =
        Date.UTC(to.year, to.month - 1, to.day) -
        Date.UTC(from.year, from.month - 1, from.day);
      return Math.floor(diff / 86_400_000) + 1;
    }
    case 'month':
      return (to.year - from.year) * 12 + (to.month - from.month) + 1;
    case 'year':
      return to.year - from.year + 1;
    default:
      return 0;
  }
}

function generateAnalyticsBuckets(
  fromDate: string,
  toDate: string,
  groupBy: FinanceAnalyticsGroupBy,
): AnalyticsBucketDescriptor[] {
  const from = splitIsoDate(fromDate);
  const to = splitIsoDate(toDate);

  if (groupBy === 'day') {
    const buckets: AnalyticsBucketDescriptor[] = [];
    const start = Date.UTC(from.year, from.month - 1, from.day);
    const end = Date.UTC(to.year, to.month - 1, to.day);
    for (let t = start; t <= end; t += 86_400_000) {
      const dateStr = formatUtcAsIsoDate(new Date(t));
      buckets.push({
        key: dateStr,
        label: dateStr,
        start: parseIstanbulDayStart(dateStr),
        end: parseIstanbulDayEnd(dateStr),
      });
    }
    return buckets;
  }

  if (groupBy === 'month') {
    const buckets: AnalyticsBucketDescriptor[] = [];
    let year = from.year;
    let month = from.month;
    while (year < to.year || (year === to.year && month <= to.month)) {
      const monthStr = String(month).padStart(2, '0');
      const key = `${year}-${monthStr}`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const lastDayStr = String(lastDay).padStart(2, '0');
      buckets.push({
        key,
        label: key,
        start: parseIstanbulDayStart(`${year}-${monthStr}-01`),
        end: parseIstanbulDayEnd(`${year}-${monthStr}-${lastDayStr}`),
      });
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return buckets;
  }

  // year
  const buckets: AnalyticsBucketDescriptor[] = [];
  for (let year = from.year; year <= to.year; year += 1) {
    const key = String(year);
    buckets.push({
      key,
      label: key,
      start: parseIstanbulDayStart(`${year}-01-01`),
      end: parseIstanbulDayEnd(`${year}-12-31`),
    });
  }
  return buckets;
}

function computeAnalyticsBucketKey(
  date: Date,
  groupBy: FinanceAnalyticsGroupBy,
): string {
  const parts = istanbulDateParts(date);
  if (groupBy === 'day') return `${parts.year}-${parts.month}-${parts.day}`;
  if (groupBy === 'month') return `${parts.year}-${parts.month}`;
  return parts.year;
}
