import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminPermission,
  CreditTransactionType,
  OfferPackageType,
  CatalogAuditEntity,
  Prisma,
  PromoConsumptionSource,
  ServiceCategoryStatus,
} from '@prisma/client';
import { CREDIT_LEDGER_INTEGER_MAX, creditBalanceLimitExceeded, fitsCreditLedger } from '../../common/credit-limits';
import { AuditPageQueryDto } from '../../common/admin-audit';
import {
  creditPackageAuditSelect,
  creditPackageAuditSnapshot,
  readCatalogAudit,
  recordCatalogAudit,
} from '../../common/catalog-audit';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { assertDeltaPermissions } from '../auth/delta-permissions';
import { staffActorSelect } from '../auth/embedded-permissions';
import {
  debitWallet,
  readSpendablePromoLots,
  readWalletBreakdown,
  WalletDebitRefused,
  WalletInvariantViolation,
} from './promo-credit-ledger';
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
  private readonly logger = new Logger(CreditsService.name);

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

  /**
   * Creates a credit package.
   *
   * An active package is on sale the moment it exists, which is the same fact
   * `PATCH …/status` guards with CREDIT_PACKAGES_STATUS. So creating one active
   * needs that permission as well as the route's CREDIT_PACKAGES_WRITE
   * (ADMIN-DESTRUCTIVE-CONFIRMATION-001); before, WRITE alone could put a
   * package on sale and the status split held only for edits. An inactive
   * package needs WRITE alone. An absent `isActive` still means active — the
   * contract every existing client was written against — and so needs both.
   */
  async createCreditPackage(dto: CreateCreditPackageDto, actor: Pick<AuthUser, 'id' | 'role' | 'permissions'>) {
    assertDeltaPermissions(
      actor,
      { business: true, status: resolveCreatedPackageIsActive(dto) },
      {
        write: AdminPermission.CREDIT_PACKAGES_WRITE,
        status: AdminPermission.CREDIT_PACKAGES_STATUS,
      },
    );

    const type = dto.type ?? OfferPackageType.ONE_TIME_CREDITS;
    const scopeCategoryIds = await this.readScopeSelection(type, dto.scopeCategoryIds);

    try {
      // ADMIN-ACTION-AUDIT-001: the package and its CREATED audit entry commit together.
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.offerCreditPackage.create({
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
        await recordCatalogAudit(tx, {
          entityType: CatalogAuditEntity.CREDIT_PACKAGE,
          entityId: created.id,
          before: null,
          after: await readCreditPackageAuditSnapshot(tx, created.id),
          actorId: actor.id,
        });
        return created;
      });
    } catch (error) {
      handleCreditPackageWriteError(error);
    }
  }

  /**
   * Edits a credit package. What the caller needs depends on what would change
   * (BUG-RBAC-STATUS-001).
   *
   * The route admits a holder of CREDIT_PACKAGES_WRITE or
   * CREDIT_PACKAGES_STATUS. Inside one serializable transaction the stored row
   * (and its scope) is compared with the normalised request:
   * - a business field or scope with a new value needs CREDIT_PACKAGES_WRITE;
   * - an `isActive` with a new value needs CREDIT_PACKAGES_STATUS;
   * - both need both.
   * An unchanged value is not a change, and `isActive` is written only when it
   * changes, so a stale echo from a form cannot switch a package back on or
   * off.
   */
  async updateCreditPackage(
    id: string,
    dto: UpdateCreditPackageDto,
    actor: Pick<AuthUser, 'id' | 'role' | 'permissions'>,
  ) {
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

    // The type never changes (it is not on the DTO), so the payload built from
    // it here is the payload the transaction writes.
    const { isActive: requestedIsActive, ...businessPayload } = creditPackageUpdatePayload(
      dto,
      existing.type,
    );

    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          const current = await tx.offerCreditPackage.findUnique({
            where: { id },
            include: { scopeCategories: { select: { categoryId: true } } },
          });
          if (!current) {
            throw new NotFoundException('Credit package not found');
          }

          const statusChanges =
            requestedIsActive !== undefined && requestedIsActive !== current.isActive;
          const fieldChanges = (Object.keys(businessPayload) as (keyof typeof businessPayload)[]).some(
            (field) => businessPayload[field] !== current[field],
          );
          const scopeChanges =
            scopeCategoryIds !== null &&
            !sameMembers(
              scopeCategoryIds,
              current.scopeCategories.map((entry) => entry.categoryId),
            );

          assertDeltaPermissions(
            actor,
            { business: fieldChanges || scopeChanges, status: statusChanges },
            {
              write: AdminPermission.CREDIT_PACKAGES_WRITE,
              status: AdminPermission.CREDIT_PACKAGES_STATUS,
            },
          );

          const before = await readCreditPackageAuditSnapshot(tx, id);
          const updated = await tx.offerCreditPackage.update({
            where: { id },
            data: {
              ...businessPayload,
              ...(statusChanges ? { isActive: requestedIsActive } : {}),
              ...(scopeCategoryIds === null
                ? {}
                : {
                    // Replaced wholesale. Every entitlement already sold
                    // carries its own frozen copy of the old scope, so
                    // rewriting this one cannot reach a period somebody has
                    // paid for.
                    scopeCategories: {
                      deleteMany: {},
                      create: scopeCategoryIds.map((categoryId) => ({ categoryId })),
                    },
                  }),
            },
            include: adminPackageInclude,
          });

          // ADMIN-ACTION-AUDIT-001: before and after this write, scope
          // included; an echo of unchanged values records nothing.
          await recordCatalogAudit(tx, {
            entityType: CatalogAuditEntity.CREDIT_PACKAGE,
            entityId: id,
            before,
            after: await readCreditPackageAuditSnapshot(tx, id),
            actorId: actor.id,
          });

          return updated;
        },
        { label: 'creditPackages.update' },
      );
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

  async updateCreditPackageStatus(id: string, isActive: boolean, actor: Pick<AuthUser, 'id'>) {
    await this.ensureCreditPackageExists(id);

    // ADMIN-ACTION-AUDIT-001: the switch and its audit row commit together;
    // switching a package to the state it is already in records nothing.
    return runSerializable(
      this.prisma,
      async (tx) => {
        const before = await readCreditPackageAuditSnapshot(tx, id);
        const updated = await tx.offerCreditPackage.update({
          where: { id },
          data: { isActive },
        });
        await recordCatalogAudit(tx, {
          entityType: CatalogAuditEntity.CREDIT_PACKAGE,
          entityId: id,
          before,
          after: await readCreditPackageAuditSnapshot(tx, id),
          actorId: actor.id,
        });
        return updated;
      },
      { label: 'creditPackages.updateStatus' },
    );
  }

  /** A credit package's catalogue history, newest first (ADMIN-ACTION-AUDIT-001). */
  async getCreditPackageHistory(id: string, query: AuditPageQueryDto | undefined, viewer: AuthUser) {
    await this.ensureCreditPackageExists(id);
    return readCatalogAudit(this.prisma, CatalogAuditEntity.CREDIT_PACKAGE, id, query, viewer);
  }

  /**
   * `actorViewer`: when set, each row names its operator (`createdBy`), with
   * the operator's e-mail only for a viewer who may read it
   * (`mayEmbedStaffEmail`, ADMIN_USERS_READ). Unset — the provider's own read —
   * no actor at all.
   */
  async getProviderCredits(providerId: string, options: { actorViewer?: AuthUser | null } = {}) {
    await this.ensureProviderExists(providerId);
    const [balance, transactions] = await Promise.all([
      this.getProviderCreditBalance(providerId),
      this.prisma.providerCreditTransaction.findMany({
        where: { providerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        ...(options.actorViewer
          ? { include: { createdBy: staffActorSelect(options.actorViewer) } }
          : {}),
      }),
    ]);

    return {
      providerId,
      balance,
      transactions,
    };
  }

  /**
   * The staff read of one provider's credits (ADMIN-DESIGN-000, F4).
   *
   * The same balance and latest movements the provider's own route returns,
   * always with the actor (as `/finance/credit-ledger` shows it), plus the
   * few provider fields the screen labels itself with.
   */
  async getProviderCreditsForAdmin(providerId: string, viewer: AuthUser) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true, businessName: true, status: true, city: true, district: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
    const [credits, wallet] = await Promise.all([
      this.getProviderCredits(providerId, { actorViewer: viewer }),
      this.readAdminWalletBreakdown(providerId),
    ]);
    return { ...credits, provider, ...wallet };
  }

  /**
   * The wallet split an operator needs before a manual deduction
   * (CAMPAIGN-CREDIT-POLICY-001): aggregates only — no lot, no campaign name,
   * nothing from the campaign domain beyond how much of the balance the
   * deduction may take. One RepeatableRead snapshot, so the balance and the
   * lots agree. A wallet whose promo exceeds its balance is reported as such
   * rather than turned into a 500 for the whole screen; any deduction on it
   * is refused by the debit itself.
   */
  private async readAdminWalletBreakdown(providerId: string): Promise<{
    walletBreakdown: AdminWalletBreakdown | null;
    walletBreakdownError: 'WALLET_INVARIANT_VIOLATION' | null;
  }> {
    try {
      const breakdown = await this.prisma.$transaction((tx) => readWalletBreakdown(tx, providerId, new Date()), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      return {
        walletBreakdown: {
          paidCredits: breakdown.paidCredits,
          promoDeductibleCredits: breakdown.promoDeductibleCredits,
          promoProtectedCredits: breakdown.promoProtectedCredits,
          promoUnsweptExpiredCredits: breakdown.promoUnsweptExpiredCredits,
          deductibleCredits: breakdown.deductibleCredits,
        },
        walletBreakdownError: null,
      };
    } catch (error) {
      if (error instanceof WalletInvariantViolation) {
        this.logger.error(error.message);
        return { walletBreakdown: null, walletBreakdownError: 'WALLET_INVARIANT_VIOLATION' };
      }
      throw error;
    }
  }

  /**
   * The signed-in provider's own spendable promotion (CMP-004 S4).
   *
   * Resolved from the session's account and nothing else: the route takes no
   * provider id, so a caller cannot name another provider and learn — from a
   * 403 against a 404, or from how long each takes — whether that id exists.
   * An account that owns no profile is refused rather than answered with an
   * empty list, so "no promotion" is never confused with "no provider".
   */
  async getMyPromoCredits(userId: string) {
    const provider = await this.prisma.providerProfile.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }
    return readSpendablePromoLots(this.prisma, provider.id, new Date());
  }

  async listProviderCreditTransactions(
    providerId: string,
    options: { actorViewer?: AuthUser | null } = {},
  ) {
    await this.ensureProviderExists(providerId);

    return this.prisma.providerCreditTransaction.findMany({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(options.actorViewer
        ? { include: { createdBy: staffActorSelect(options.actorViewer) } }
        : {}),
    });
  }

  grantCredits(providerId: string, dto: ManualCreditTransactionDto, createdById: string) {
    return this.manualCreditOperation(providerId, CreditTransactionType.ADMIN_GRANT, dto, createdById);
  }

  /**
   * ADMIN_DEDUCT (CAMPAIGN-CREDIT-POLICY-001): through the canonical wallet
   * debit with purpose ADMIN_DEDUCT — paid credit, plus the promo lots whose
   * version allows it (ALLOW_PROMO) in waterfall order. A PAID_ONLY lot is
   * never touched. All or nothing; one ledger row; promo shares recorded as
   * `source = ADMIN_DEDUCT`.
   */
  deductCredits(providerId: string, dto: ManualCreditTransactionDto, createdById: string) {
    return this.manualCreditOperation(providerId, CreditTransactionType.ADMIN_DEDUCT, dto, createdById);
  }

  /**
   * One manual movement, exactly once per idempotency key
   * (CAMPAIGN-CREDIT-POLICY-001).
   *
   * The admin panel's confirmation proof is spent by the first submission and
   * lives in one process's memory; it cannot tell a retry of a committed
   * operation from a new one. The key can: the client draws it once per
   * business operation and repeats it on every retry. Inside one Serializable
   * transaction the key is looked up first — the same key with the same
   * payload answers the original ledger row and writes nothing; with another
   * payload it is a 409 — and otherwise the movement and its
   * `ManualCreditOperation` row commit together. Two concurrent first
   * attempts meet at the unique key: the loser re-reads and answers the
   * winner's row.
   */
  private async manualCreditOperation(
    providerId: string,
    type: typeof CreditTransactionType.ADMIN_GRANT | typeof CreditTransactionType.ADMIN_DEDUCT,
    dto: ManualCreditTransactionDto,
    actorId: string,
  ) {
    const amount = normalizePositiveAmount(dto.amount);
    const reason = normalizeRequiredReason(dto.reason);
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const operation = { idempotencyKey, providerId, type, requestedCredits: amount, reason, actorId };

    try {
      return await runSerializable(
        this.prisma,
        async (tx) => {
          const replay = await readManualReplay(tx, operation);
          if (replay) {
            return replay;
          }
          await this.ensureProviderExistsIn(tx, providerId);

          const row =
            type === CreditTransactionType.ADMIN_GRANT
              ? await this.createProviderCreditTransactionInTransaction(
                  tx,
                  { providerId, type, amount, reason, createdById: actorId },
                  { maxBalanceAfter: CREDIT_LEDGER_INTEGER_MAX },
                )
              : await deductInTransaction(tx, { providerId, amount, reason, actorId });

          await tx.manualCreditOperation.create({
            data: { ...operation, transactionId: row.id },
            select: { id: true },
          });
          return row;
        },
        { label: type === CreditTransactionType.ADMIN_GRANT ? 'credits.manualGrant' : 'credits.manualDeduct' },
      );
    } catch (error) {
      if (isIdempotencyKeyCollision(error)) {
        const replay = await readManualReplay(this.prisma, operation);
        if (replay) {
          return replay;
        }
      }
      throw error;
    }
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

  /**
   * Whether `amount` more credit fits under the ledger's integer column
   * (API-HARDENING-001).
   *
   * Read inside the caller's transaction so the answer and the write that
   * follows it see the same balance. Callers that settle money use this to
   * refuse *before* writing anything — the webhook turns a refusal into a
   * recorded, recoverable outcome rather than an exception — and pass
   * `maxBalanceAfter` to the write as the second line of the same rule.
   */
  async readCreditHeadroom(client: CreditTransactionTx | PrismaService, providerId: string, amount: number) {
    const latest = await client.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true },
    });
    const currentBalance = latest?.balanceAfter ?? 0;
    return {
      currentBalance,
      maxBalance: CREDIT_LEDGER_INTEGER_MAX,
      fits: fitsCreditLedger(currentBalance, amount),
    };
  }

  /**
   * The same refusal every credit-loading path answers with: 400
   * `CREDIT_BALANCE_LIMIT_EXCEEDED`, nothing written. Advisory where it runs
   * before money moves (checkout); binding where it runs in the settling
   * transaction.
   */
  async assertCreditHeadroom(client: CreditTransactionTx | PrismaService, providerId: string, amount: number) {
    const headroom = await this.readCreditHeadroom(client, providerId, amount);
    if (!headroom.fits) {
      throw creditBalanceLimitExceeded(headroom.currentBalance, headroom.maxBalance);
    }
  }

  /**
   * One ledger row, chained onto the provider's latest balance.
   *
   * `maxBalanceAfter` is opt-in. The manual path and every credit-*loading*
   * settlement pass it (API-HARDENING-001: the mock payment, and the webhook
   * behind its own pre-check), so a balance past the ledger's integer column
   * is a 400 with nothing written rather than a database 500. The entitlement
   * resolver writes only debits, which cannot overflow upwards.
   */
  async createProviderCreditTransactionInTransaction(
    tx: CreditTransactionTx,
    input: CreditTransactionInput,
    options: { maxBalanceAfter?: number } = {},
  ) {
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

    if (options.maxBalanceAfter !== undefined && balanceAfter > options.maxBalanceAfter) {
      throw creditBalanceLimitExceeded(currentBalance, options.maxBalanceAfter);
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

  private async ensureProviderExistsIn(tx: CreditTransactionTx, providerId: string) {
    const provider = await tx.providerProfile.findUnique({ where: { id: providerId }, select: { id: true } });
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }
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

/** Whether a create request makes an active package: absent means active. */
function resolveCreatedPackageIsActive(dto: Pick<CreateCreditPackageDto, 'isActive'>): boolean {
  return dto.isActive ?? true;
}

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
    isActive: resolveCreatedPackageIsActive(dto),
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

/** Whether two id lists name the same set, order and duplicates ignored. */
function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
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

async function readCreditPackageAuditSnapshot(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.offerCreditPackage.findUniqueOrThrow({ where: { id }, select: creditPackageAuditSelect });
  return creditPackageAuditSnapshot(row);
}

// ───────────────────── manual movements (CAMPAIGN-CREDIT-POLICY-001) ─────────────────────

export const CREDIT_BALANCE_INSUFFICIENT = 'CREDIT_BALANCE_INSUFFICIENT';
export const CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE = 'CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE';
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const WALLET_INVARIANT_VIOLATION = 'WALLET_INVARIANT_VIOLATION';

/** What the admin credit screen is told about the wallet: aggregates, nothing per lot or per campaign. */
export type AdminWalletBreakdown = {
  paidCredits: number;
  promoDeductibleCredits: number;
  promoProtectedCredits: number;
  promoUnsweptExpiredCredits: number;
  deductibleCredits: number;
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function normalizeIdempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'idempotencyKey must be 16–128 characters of A–Z, a–z, 0–9, "-" or "_"',
    });
  }
  return value;
}

type ManualOperationInput = {
  idempotencyKey: string;
  providerId: string;
  type: CreditTransactionType;
  requestedCredits: number;
  reason: string;
  actorId: string;
};

/**
 * The original ledger row when this key was already used for exactly this
 * operation; null when the key is new; a 409 when the key names another
 * operation (another provider, direction, amount, reason or operator) — a
 * reused key must never quietly stand for something it did not do.
 */
async function readManualReplay(db: CreditTransactionTx | PrismaService, operation: ManualOperationInput) {
  const existing = await db.manualCreditOperation.findUnique({
    where: { idempotencyKey: operation.idempotencyKey },
    select: {
      providerId: true,
      type: true,
      requestedCredits: true,
      reason: true,
      actorId: true,
      transaction: true,
    },
  });
  if (!existing) {
    return null;
  }
  const same =
    existing.providerId === operation.providerId &&
    existing.type === operation.type &&
    existing.requestedCredits === operation.requestedCredits &&
    existing.reason === operation.reason &&
    existing.actorId === operation.actorId;
  if (!same) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: IDEMPOTENCY_KEY_REUSED,
      message: 'This idempotency key was already used for a different credit operation',
    });
  }
  return existing.transaction;
}

function isIdempotencyKeyCollision(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  return fields.some((field) => field.includes('idempotencyKey'));
}

/**
 * ADMIN_DEDUCT through the shared wallet debit. The refusals an operator can
 * act on are stable codes; the message of the whole-balance case is the one
 * the panel has always matched.
 */
async function deductInTransaction(
  tx: CreditTransactionTx,
  input: { providerId: string; amount: number; reason: string; actorId: string },
) {
  try {
    const { transaction } = await debitWallet(tx, {
      providerId: input.providerId,
      amount: input.amount,
      purpose: PromoConsumptionSource.ADMIN_DEDUCT,
      now: new Date(),
      ledger: { reason: input.reason, referenceType: null, referenceId: null, createdById: input.actorId },
    });
    return transaction;
  } catch (error) {
    if (error instanceof WalletDebitRefused) {
      const { breakdown } = error;
      if (error.reason === 'INSUFFICIENT_BALANCE') {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: CREDIT_BALANCE_INSUFFICIENT,
          message: 'Credit balance cannot go below zero',
          requestedCredits: error.requestedCredits,
          balance: breakdown.balance,
        });
      }
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE,
        message: 'The deduction exceeds the credit an admin deduction may take',
        requestedCredits: error.requestedCredits,
        deductibleCredits: breakdown.deductibleCredits,
        paidCredits: breakdown.paidCredits,
        protectedPromoCredits: breakdown.promoProtectedCredits,
        balance: breakdown.balance,
      });
    }
    if (error instanceof WalletInvariantViolation) {
      throw new InternalServerErrorException({
        statusCode: 500,
        error: 'Internal Server Error',
        code: WALLET_INVARIANT_VIOLATION,
        message: 'The provider wallet is inconsistent; nothing was deducted',
      });
    }
    throw error;
  }
}
