import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  NumberedEntityType,
  OfferRejectionReason,
  OfferStatus,
  Prisma,
  ProviderServiceAreaScope,
  ProviderStatus,
  ServiceCategoryKind,
  ServiceCategoryStatus,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import {
  isValidProviderEmail,
  normalizeProviderEmail,
  sameProviderEmail,
} from '../../common/provider-email';
import { assertEmailFreeForAccountKind } from '../../common/account-email';
import {
  isRequestVisibleToProviders,
  matchesProviderArea,
  phoneVerifiedRequestFilter,
} from '../../common/provider-request-matching';
import { runSerializable } from '../../common/serializable-transaction';
import { EntitlementResolverService } from '../entitlements/entitlement-resolver.service';
import { OperationsSettingsService } from '../operations-settings/operations-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  canBeAssignedByAdmin,
  canBeSelectedByProviders,
  isProviderEnrollmentOpen,
  providerEnrollmentCategoryWhere,
  isLiveProviderBinding,
} from '../categories/category-taxonomy';
import { resolveArea, resolveLocation } from '../locations/turkey-locations';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { NumberingService } from '../numbering/numbering.service';
import {
  offerNotWithdrawableException,
  WITHDRAWABLE_OFFER_STATUSES,
} from '../offers/offer-transitions';
import { calculateRefundEligibility } from '../offers/refund-policy';
import {
  isClaimableProviderStatus,
  isProviderClaimEnabled,
} from '../provider-claim/provider-claim.config';
import { ProviderClaimService } from '../provider-claim/provider-claim.service';
import { AddProviderServiceCategoryDto } from './dto/add-provider-service-category.dto';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CreateProviderDto, ProviderServiceAreaDto } from './dto/create-provider.dto';
import {
  areaCovers,
  describeArea,
  toServiceAreaRow,
  type ScopedArea,
} from '../../common/provider-service-area-scope';
import { UpdateProviderStatusDto } from './dto/update-provider-status.dto';
import { UpdateProviderDto } from './dto/update-provider.dto';

type ProviderOwnershipFilter = 'claimed' | 'unclaimed';

type ProviderListFilters = {
  status?: string;
  city?: string;
  categoryId?: string;
  ownership?: string;
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
  /** Scope included, because it is derived here and written verbatim. */
  serviceAreas: Array<{
    scope: ProviderServiceAreaScope;
    city: string;
    district: string | null;
    neighborhood: string | null;
  }>;
};

/**
 * The application fields an invitation carries: every field a guest application
 * has, except the one the invitation itself decides.
 *
 * `categoryIds` is absent rather than optional on purpose. The invitation names
 * the service, and a client that could name one too would be a client that
 * decides which unreleased category it is applying for — so there is no field
 * for it to send, and the global ValidationPipe refuses a body that invents
 * one.
 */
export type ProviderInviteApplicationFields = Omit<CreateProviderDto, 'categoryIds'>;

/** What the payload normaliser reads, whichever of the three forms it came as. */
type ProviderApplicationInput = ProviderInviteApplicationFields & {
  categoryIds?: string[];
};

/** The client address, carried only so a claim invitation can be rate limited. */
type ApplicationRequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';
/**
 * Machine-readable codes for the offer-pricing conflicts, so the web app can
 * render a specific explanation instead of a generic error screen.
 */
export const CATEGORY_PRICE_UNSET_CODE = 'CATEGORY_PRICE_UNSET';
export const CREDIT_COST_CHANGED_CODE = 'CREDIT_COST_CHANGED';
export const CATEGORY_INACTIVE_CODE = 'CATEGORY_INACTIVE';

/**
 * Refused when an operator tries to bind a provider to something that is not a
 * service: a group, a router, or a category the marketplace has closed.
 *
 * A code rather than a bare message because the admin screen explains each of
 * the three in the operator's own words, and a screen that has to match on a
 * sentence is a screen that breaks when the sentence is reworded.
 */
export const CATEGORY_NOT_ASSIGNABLE_CODE = 'CATEGORY_NOT_ASSIGNABLE';

/**
 * Refused when a guest application arrives without a usable contact address
 * while the claim flow is on. Such an application could never be handed to
 * anybody: the claim link is the only proof of ownership the flow has.
 */
export const PROVIDER_EMAIL_REQUIRED_CODE = 'PROVIDER_EMAIL_REQUIRED';

/**
 * Refused when a claimed application tries to move its contact address.
 *
 * The account's e-mail and the application's e-mail are set equal at the moment
 * a claim grants ownership, and nothing afterwards may pull them apart — an
 * application whose contact address is not the owner's would let a future
 * invitation reach somebody who is not the owner.
 *
 * Scoped to claimed applications only. A profile a signed-in provider created
 * for themselves was never claimed, so it carries none of that history and
 * keeps its ordinary editing behaviour.
 */
export const PROVIDER_EMAIL_IMMUTABLE_CODE = 'PROVIDER_EMAIL_IMMUTABLE';

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(ProviderClaimService) private readonly providerClaim: ProviderClaimService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(EntitlementResolverService)
    private readonly entitlements: EntitlementResolverService,
    @Inject(OperationsSettingsService)
    private readonly operationsSettings: OperationsSettingsService,
  ) {}

  async createProvider(
    dto: CreateProviderDto,
    user: AuthUser | null = null,
    meta: ApplicationRequestMeta = {},
  ) {
    const payload = await this.prepareApplication(dto, user);

    let provider: Awaited<ReturnType<ProvidersService['createApplicationRecord']>>;

    try {
      provider = await this.createApplicationRecord(this.prisma, payload, user);
    } catch (error) {
      throw translateApplicationWriteError(error);
    }

    await this.announceNewApplication(provider.id, user, meta);

    return withVisibleServiceCategories(provider);
  }

  /**
   * Everything that has to be true before an application may be written, and
   * the normalised payload that survives it.
   *
   * Split out of {@link createProvider} so the invitation flow runs the same
   * checks rather than a second, drifting copy of them: who may apply at all,
   * whether this account already owns a profile, whether the address is
   * reachable, and what the submitted values normalise to. The invitation adds
   * exactly one thing on top — which category the application is bound to — and
   * takes nothing away.
   */
  async prepareApplication(
    dto: CreateProviderDto | ProviderInviteApplicationFields,
    user: AuthUser | null,
    serverChosenCategoryIds?: string[],
  ): Promise<NormalizedProviderPayload> {
    if (user?.role === UserRole.CUSTOMER) {
      throw new ForbiddenException('Customers cannot create provider profiles');
    }

    // An account owns at most one provider profile. Checked here so the caller
    // gets an explanatory 409 rather than a raw constraint violation; the unique
    // index on ProviderProfile.userId is still the source of truth and is
    // handled by translateApplicationWriteError for the concurrent-request case.
    if (user?.role === UserRole.PROVIDER) {
      const existing = await this.prisma.providerProfile.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('Bu hesap için zaten bir hizmet veren profili var.');
      }
    }

    const payload = await this.normalizeAndValidatePayload(dto, serverChosenCategoryIds);

    // An application nobody is signed in for is the one the claim flow exists
    // for, and it is the only one that needs a reachable address. A provider
    // creating their own profile is already the owner, so their address stays
    // as optional as it has always been.
    if (willBeUnownedApplication(user)) {
      if (isProviderClaimEnabled()) {
        requireClaimableApplicationEmail(payload.email);
      }

      // The address on an unowned application is the address a claim link is
      // mailed to and the address the resulting provider account is opened
      // under, so filing one against a customer's address is an attempt to open
      // the second kind of account there. It used to be accepted: the row was
      // written, the invitation went to the customer's own mailbox, and the
      // flow only dead-ended much later when the claim refused to bind them.
      // Refusing here is checked whether or not the claim flow is switched on —
      // the rule is about accounts, not about a feature flag.
      if (payload.email) {
        await assertEmailFreeForAccountKind(this.prisma, payload.email, UserRole.PROVIDER);
      }
    }

    return payload;
  }

  /**
   * Writes the application row on whatever client the caller hands it.
   *
   * The client is a parameter rather than `this.prisma` because the invitation
   * flow has to create the application and spend the invitation in one
   * transaction — an application that exists against an invitation still marked
   * unused is a link that can be redeemed twice.
   *
   * Which categories the row is bound to was decided in
   * {@link ProvidersService.prepareApplication} and is already in the payload —
   * so there is no second place, and no caller-supplied list, that could put an
   * application against a category the checks above never saw.
   */
  createApplicationRecord(
    client: Pick<Prisma.TransactionClient, 'providerProfile'>,
    payload: NormalizedProviderPayload,
    user: AuthUser | null,
  ) {
    return client.providerProfile.create({
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

  /**
   * The two messages every new application triggers, after it is safely stored.
   *
   * Both are best-effort and both are outside the write, deliberately: a
   * transport failure must not undo an application the applicant already
   * completed. An invited application is a guest application like any other, so
   * it gets exactly these two and nothing extra — the invitation itself is not
   * mailed by this platform in this round.
   */
  async announceNewApplication(
    providerId: string,
    user: AuthUser | null,
    meta: ApplicationRequestMeta = {},
  ): Promise<void> {
    if (willBeUnownedApplication(user)) {
      // A no-op while the claim flag is off.
      await this.providerClaim.issueForNewApplication(providerId, meta);
    }

    // The receipt, which is a different message from the claim invitation
    // above: one says "we have your application", the other hands over
    // ownership of it. An owned application gets only this one.
    await this.notify(() => this.mail.sendProviderApplicationReceived(providerId), providerId);
  }

  async listProviders(filters: ProviderListFilters) {
    const status = normalizeOptionalStatus(filters.status);
    const city = normalizeNullableString(filters.city);
    const categoryId = normalizeNullableString(filters.categoryId);
    const ownership = normalizeOptionalOwnership(filters.ownership);

    const providers = await this.prisma.providerProfile.findMany({
      where: {
        ...(status ? { status } : {}),
        // "Providers who serve this city", not "providers whose profile names
        // it". A business whose profile location is in Kocaeli and whose only
        // service area is İstanbul is an İstanbul provider to everyone who
        // matters — the customer, the matching rule, and the operator asking
        // who covers a province. Since coverage became a list, the legacy
        // location can no longer answer that question, so it is what the row
        // prints and never what it is selected by.
        ...(city
          ? { serviceAreas: { some: { city: { equals: city, mode: 'insensitive' } } } }
          : {}),
        ...(categoryId
          ? {
              serviceCategories: {
                some: { categoryId },
              },
            }
          : {}),
        // "Unclaimed" is exactly "no account owns this", which is the one
        // question the applications queue is about. It deliberately does not
        // split owned profiles by how they got their owner.
        ...(ownership === 'unclaimed' ? { userId: null } : {}),
        ...(ownership === 'claimed' ? { userId: { not: null } } : {}),
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

    // The owner is not an operator. A provider reading their own profile sees
    // the categories they chose and can act on; a DRAFT binding is an admin's
    // release preparation, and its name and slug are exactly what the
    // unreleased catalogue must not leak.
    if (visibility === 'owner') {
      return { ...withVisibleServiceCategories(provider), visibility };
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
      claim,
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
      this.providerClaim.getClaimSummary(id),
    ]);

    return {
      ...provider,
      creditBalance,
      activeOffersCount,
      totalOffersCount,
      packagePurchasesCount,
      recentOffers,
      recentPackagePurchases,
      claim,
      claimEnabled: isProviderClaimEnabled(),
    };
  }

  /**
   * Binds a provider to a category, by hand, as an operator.
   *
   * The one path that may reach a DRAFT category, and the reason it exists:
   * before releasing an unreleased service somebody has to be able to say
   * "these are the businesses that will answer its requests", and there is no
   * way for the businesses themselves to say it — the category is invisible to
   * them by design.
   *
   * What it deliberately is not: a way to widen anything else. The binding is
   * inert until the category is released (see isLiveProviderBinding), and a
   * provider who is not APPROVED does not count towards readiness however many
   * bindings they carry — the count is computed from the provider's status at
   * read time, so approving them later is what makes them count, not a
   * re-binding.
   *
   * Idempotent: the same pair a second time is the same one row, and the unique
   * index on (providerId, categoryId) is what makes that true — including for
   * two operators pressing the button at the same moment, which a read-then-
   * write check would let through.
   */
  async addServiceCategory(providerId: string, dto: AddProviderServiceCategoryDto) {
    await this.ensureProviderExists(providerId);

    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: dto.categoryId },
      select: { id: true, kind: true, status: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (!canBeAssignedByAdmin(category)) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: CATEGORY_NOT_ASSIGNABLE_CODE,
        message:
          'Yalnızca yayında veya taslak durumdaki hizmet kategorileri bir hizmet verene bağlanabilir.',
      });
    }

    let created = true;

    try {
      await this.prisma.providerServiceCategory.create({
        data: { providerId, categoryId: category.id },
      });
    } catch (error) {
      // P2002 is the unique index on (providerId, categoryId) doing the job the
      // idempotency promise is made of. Two operators pressing the same button
      // is a duplicate request, not a failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        created = false;
      } else {
        throw error;
      }
    }

    return { ...(await this.getAdminServiceCategories(providerId)), created };
  }

  /**
   * Removes a binding, whatever the category's status.
   *
   * Unrestricted by kind or status on purpose: removal can only ever narrow
   * supply, and a binding to a category that has since been closed is exactly
   * the row an operator most needs to be able to clear.
   *
   * Idempotent in the same sense as the add: removing what is not there is a
   * completed request, and `removed` says which of the two happened.
   */
  async removeServiceCategory(providerId: string, categoryId: string) {
    await this.ensureProviderExists(providerId);

    const { count } = await this.prisma.providerServiceCategory.deleteMany({
      where: { providerId, categoryId },
    });

    return { ...(await this.getAdminServiceCategories(providerId)), removed: count > 0 };
  }

  /**
   * The operator's view of a provider's service list: every binding, drafts
   * included, each one saying whether it is currently doing anything.
   *
   * `countsForRelease` is the honest answer to the question the readiness panel
   * asks, restated per binding so the screen can say *why* a category the
   * operator just attached somebody to still reads as having nobody: the count
   * behind the release decision only ever counts APPROVED providers, and this
   * provider is not one.
   */
  async getAdminServiceCategories(providerId: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        status: true,
        serviceCategories: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            categoryId: true,
            createdAt: true,
            category: {
              select: { id: true, name: true, slug: true, kind: true, status: true },
            },
          },
        },
      },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    const countsForRelease = provider.status === ProviderStatus.APPROVED;

    return {
      providerId: provider.id,
      providerStatus: provider.status,
      serviceCategories: provider.serviceCategories.map((binding) => ({
        ...binding,
        countsForRelease,
      })),
    };
  }

  /**
   * Re-sends the claim invitation for an application nobody owns yet.
   *
   * The result carries a status and an expiry and nothing else. Handing the
   * link back over HTTP would make the mailbox stop being the thing that proves
   * ownership, and it is the same reason the customer activation path returns
   * no URL either.
   */
  async resendClaimInvitation(
    providerId: string,
    actor: AuthUser,
    meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  ) {
    return this.providerClaim.resendForProvider(providerId, actor.id, meta);
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

    return withVisibleServiceCategories(provider);
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
      provider: withVisibleServiceCategories(provider),
      creditBalance,
      activeOffersCount,
      recentOffersCount,
      matchingApprovedRequestsCount,
    };
  }

  async updateProvider(id: string, dto: UpdateProviderDto, user: AuthUser | null = null) {
    const existingProvider = await this.getProviderForUpdate(id);
    ensureProviderUpdateAccess(existingProvider, user);
    // Read before the payload is checked, because one of the checks is about
    // them: an overlapping pair this profile already holds is not something
    // this save is introducing, so it must not be what this save is refused for.
    const storedAreas = await this.prisma.providerServiceArea.findMany({
      where: { providerId: id },
      select: { city: true, district: true, neighborhood: true },
    });
    const payload = await this.normalizeAndValidatePayload(dto, undefined, storedAreas);
    ensureContactEmailStable(existingProvider, payload.email);

    // The same rule as at submission time, from the other side. An unowned
    // application is one claim link away from being a provider account, so
    // pointing one at a customer's address — which an admin correcting a typo
    // can do — would re-create exactly the state the submission path now
    // refuses. An owned profile is untouched: its address is a contact detail,
    // not a pending account.
    if (!existingProvider.userId && payload.email) {
      await assertEmailFreeForAccountKind(this.prisma, payload.email, UserRole.PROVIDER);
    }

    return this.prisma.$transaction(async (tx) => {
      // A profile save replaces the categories the *saver* can see, and DRAFT
      // bindings are not among them: the form the provider submitted never
      // offered one, so an absent draft id means "I was never shown this",
      // never "remove it". Deleting them here would let any profile edit
      // silently undo an operator's release preparation — and the operator
      // would find out from a readiness count that quietly went back to zero.
      //
      // Nothing recreated below can collide with a surviving row:
      // Replace exactly what the provider can manage. A draft they signed
      // themselves up for is on their form, so a save must be able to drop it;
      // a draft an operator bound them to behind a closed enrollment is not on
      // their form, so a save must not be able to lose it.
      await tx.providerServiceCategory.deleteMany({
        where: {
          providerId: id,
          category: providerEnrollmentCategoryWhere,
        },
      });
      await tx.providerServiceArea.deleteMany({ where: { providerId: id } });

      const updated = await tx.providerProfile.update({
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

      // The operator's screens read the bindings from the admin detail
      // endpoint, which keeps the drafts. Everybody else — the provider saving
      // their own profile — gets the same narrowed shape every other read
      // hands them.
      return user?.role === UserRole.SUPER_ADMIN
        ? updated
        : withVisibleServiceCategories(updated);
    });
  }

  async updateProviderStatus(id: string, dto: UpdateProviderStatusDto) {
    const existing = await this.ensureProviderExists(id);
    const moderationNote = normalizeNullableString(dto.moderationNote);
    const rejectionReason = normalizeNullableString(dto.rejectionReason);

    if (dto.status === ProviderStatus.REJECTED && !rejectionReason) {
      throw new BadRequestException('Rejection reason is required when status is REJECTED');
    }

    const now = new Date();

    const provider = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.providerProfile.update({
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

      // A link mailed while the application was under review must not outlive
      // its rejection or suspension. Same transaction as the status change, so
      // there is no window in which the new status is live and an old link
      // still is. An application moving *into* a claimable status keeps its
      // links — nothing about them became untrue.
      if (!isClaimableProviderStatus(dto.status)) {
        await this.providerClaim.invalidateActiveTokens(tx, id);
      }

      return updated;
    });

    // Only a genuine transition into APPROVED. Re-saving an already-approved
    // application from the moderation screen rewrites `approvedAt` and tells
    // nobody anything; a suspension followed by a re-approval is a real second
    // approval and does mail again. The dedupe key carries `approvedAt`, so the
    // database enforces the same rule independently.
    if (dto.status === ProviderStatus.APPROVED && existing.status !== ProviderStatus.APPROVED) {
      await this.notify(() => this.mail.sendProviderApplicationApproved(id, now), id);
    }

    return provider;
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
            unviewedRefundPolicy: true,
            unviewedRefundWindowHours: true,
            unviewedRefundEligibleAt: true,
            refundBlockedAt: true,
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
    const offer = await this.createOfferRecord(providerId, requestId, dto);

    // Outside the transaction that charged the credit, so a mail failure can
    // never roll back an offer the provider has already paid for and delivered.
    await this.notify(() => this.mail.sendOfferReceived(offer.id), providerId);

    return offer;
  }

  private async createOfferRecord(providerId: string, requestId: string, dto: CreateOfferDto) {
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

          /*
           * One resolver decides what pays for this offer, in this order: an
           * active unlimited period whose snapshotted scope covers this
           * category, then an active monthly quota, then the one-time credit
           * balance, then the 402 this flow has always answered with.
           *
           * It runs *after* every other rule — the category's status and price,
           * the provider's binding to it, the area match, the one-offer-per-
           * request guard — because none of them is relaxed by holding a
           * package. An unlimited period changes what an offer costs, never who
           * may send one.
           */
          const decision = await this.entitlements.resolve(tx, {
            providerId,
            categoryId: category.id,
            creditCost: actualCreditCost,
            now: new Date(),
          });

          const offerNumber = await this.numbering.generateDisplayNumber(
            tx,
            NumberedEntityType.OFFER,
          );

          /*
           * The refund window this offer is sold under, read now and written
           * onto the offer.
           *
           * Read inside the transaction so the value the offer records and the
           * value in force when it was created are the same read, not two with
           * a gap between them. Written as a snapshot — both the hours and the
           * exact moment — so a later change to the setting governs the next
           * offer and never this one: raising the window cannot postpone a
           * refund a provider has already been promised, and lowering it cannot
           * pay one out while the customer still has the time they were given.
           *
           * `submittedAt` is set explicitly rather than left to the column
           * default, because the eligibility moment is derived from it and the
           * two must agree exactly.
           */
          const refundWindowHours =
            await this.operationsSettings.getUnviewedOfferRefundWindowHours(tx);
          const submittedAt = new Date();
          const refundEligibleAt = new Date(
            submittedAt.getTime() + refundWindowHours * 60 * 60 * 1000,
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
              // What actually paid, recorded on the offer rather than inferred
              // later from the absence of a ledger row.
              entitlementSource: decision.source,
              entitlementId: decision.entitlementId,
              // The opt-in into the unviewed-offer refund rule, written here
              // because this is the code path that shipped with it. Every offer
              // created from now on carries the promise the provider was shown;
              // every offer that predates this line keeps the column's false
              // default and is out of scope forever.
              unviewedRefundPolicy: true,
              submittedAt,
              unviewedRefundWindowHours: refundWindowHours,
              unviewedRefundEligibleAt: refundEligibleAt,
            },
          });

          // The charge itself: an atomic quota decrement, a ledger row, or —
          // for an unlimited period — nothing at all. A failure here throws, and
          // the whole transaction (offer included) rolls back, so a refused
          // offer can never have consumed anything.
          const { creditTransactionId } = await this.entitlements.consume(tx, decision, {
            providerId,
            offerId: offer.id,
            reason: `Offer submitted (${category.slug}, ${actualCreditCost} kredi)`,
            now: new Date(),
          });

          const updatedOffer = await tx.offer.update({
            where: { id: offer.id },
            data: { creditSpentTransactionId: creditTransactionId },
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

    /*
     * What the winner needs to actually do the job, and only the winner.
     *
     * A provider whose offer was accepted has to carry the work out, and the
     * two things that say what the work *is* — the customer's description and
     * the answers to the category's required questions — were reachable only
     * from the discovery screen, which stops answering once the request leaves
     * APPROVED. So the provider who won lost sight of the brief at the moment
     * they needed it.
     *
     * Decided here rather than on the screen: the status is the platform's
     * fact, not the caller's claim. Anything short of ACCEPTED gets null — a
     * losing offer, a withdrawn one, one still waiting — so no provider learns
     * anything from this that they did not already have while the request was
     * open, and a rival learns nothing at all.
     *
     * It also stays off the offers *list*, which shares `providerOfferInclude`
     * with this route: a list is a place to choose from, and it has no reason
     * to carry a brief for every row.
     */
    const acceptedWorkScope =
      offer.status === OfferStatus.ACCEPTED
        ? await this.loadAcceptedWorkScope(offer.requestId)
        : null;

    return { ...withRefundEligibility(offer), acceptedWorkScope };
  }

  /**
   * The brief for an accepted offer: what the job is, and nothing about who it
   * is for.
   *
   * Deliberately narrower than the discovery payload. It leaves out the
   * customer's name, phone and e-mail, and it leaves out the address note and
   * neighbourhood too: whether a provider may reach the customer, and where
   * exactly, is what the contact-sharing flow decides — behind its own flag,
   * its own disclosure and its own audit row. Nothing here may become a second,
   * quieter way to answer that question, so the location it carries is the
   * city and district the offer already quoted.
   *
   * Only the required questions. The optional ones are the customer's own
   * discretion and are scored as a bonus rather than as part of the brief.
   */
  private async loadAcceptedWorkScope(requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        description: true,
        answers: {
          where: { question: { isRequired: true } },
          orderBy: { createdAt: 'asc' },
          select: {
            questionKey: true,
            questionLabel: true,
            questionType: true,
            value: true,
          },
        },
      },
    });

    if (!request) {
      return null;
    }

    return {
      description: request.description,
      requiredAnswers: request.answers,
    };
  }

  /**
   * Takes a provider's own live offer off the table.
   *
   * The conditional update is the whole concurrency guard: only an offer that is
   * still in {@link WITHDRAWABLE_OFFER_STATUSES} can become WITHDRAWN, so of two
   * simultaneous withdrawals exactly one updates a row and the other reaches the
   * business rule. The same clause is what a simultaneous acceptance loses
   * against — the customer path only moves offers that are not already closed —
   * so the pair can never both write a terminal state.
   *
   * No ledger row is written and neither creditCost nor
   * creditRefundedTransactionId is touched: the provider chose to walk away from
   * an offer the platform already delivered, and that spend stands. The refund
   * policy reports the same verdict for the resulting record.
   */
  async withdrawProviderOffer(providerId: string, offerId: string) {
    await this.ensureProviderExists(providerId);
    const now = new Date();

    return runSerializable(
      this.prisma,
      async (tx) => {
        const offer = await tx.offer.findFirst({
          where: { id: offerId, providerId },
          select: { id: true, requestId: true },
        });

        // Somebody else's offer is indistinguishable from a missing one, so a
        // provider cannot probe for offer ids it does not own.
        if (!offer) {
          throw new NotFoundException('Offer not found');
        }

        const request = await tx.serviceRequest.findUnique({
          where: { id: offer.requestId },
          select: { status: true },
        });

        // A matched, completed, cancelled or expired request is settled. Its
        // offers stay exactly as that lifecycle left them.
        if (!request || request.status !== ServiceRequestStatus.APPROVED) {
          throw offerNotWithdrawableException();
        }

        const withdrawn = await tx.offer.updateMany({
          where: {
            id: offerId,
            providerId,
            status: { in: [...WITHDRAWABLE_OFFER_STATUSES] },
          },
          data: {
            status: OfferStatus.WITHDRAWN,
            withdrawnAt: now,
          },
        });

        if (withdrawn.count !== 1) {
          throw offerNotWithdrawableException();
        }

        const updated = await tx.offer.findUniqueOrThrow({
          where: { id: offerId },
          include: providerOfferInclude,
        });

        return withRefundEligibility(updated);
      },
      { label: 'providers.withdrawProviderOffer' },
    );
  }

  /**
   * `serverChosenCategoryIds`, when supplied, replaces the list the body
   * carries — and skips {@link ProvidersService.ensureActiveCategories} with
   * it.
   *
   * Only the invitation flow supplies it, and both halves of that are
   * deliberate. Replacing rather than merging is what makes "which service is
   * this application for" a fact the server derives; skipping the check is
   * because that check asks whether a *provider* may select the category, and
   * the answer for a draft is no by design. What may be invited to is a
   * different and stricter question, already answered against the stored row on
   * every single use of the link — see ProviderInvitesService.resolveLiveInvite,
   * which re-reads the category's kind and status rather than trusting what
   * they were when the link was issued.
   */
  private async normalizeAndValidatePayload(
    dto: ProviderApplicationInput,
    serverChosenCategoryIds?: string[],
    /**
     * The areas the profile already holds, on an edit. Only the overlap rule
     * reads them, and only to leave a pair it did not create alone — see
     * normalizeServiceAreas. A new application passes nothing.
     */
    alreadyStoredAreas: readonly ScopedArea[] = [],
  ): Promise<NormalizedProviderPayload> {
    const categoryIds = normalizeCategoryIds(serverChosenCategoryIds ?? dto.categoryIds ?? []);
    const serviceAreas = normalizeServiceAreas(dto.serviceAreas ?? [], alreadyStoredAreas);
    const address = normalizeBusinessAddress(dto);

    if (!serverChosenCategoryIds) {
      await this.ensureActiveCategories(categoryIds);
    }

    return {
      businessName: normalizeRequiredString(dto.businessName, 'Business name'),
      contactName: normalizeRequiredString(dto.contactName, 'Contact name'),
      phone: normalizePhone(dto.phone),
      // Folded to lower case, like User.email: the claim flow decides who may
      // take an application over by comparing the two, and a comparison between
      // a folded value and an unfolded one fails for anybody who typed a
      // capital letter.
      email: normalizeProviderEmail(dto.email),
      taxType: normalizeNullableString(dto.taxType),
      taxNumber: normalizeNullableString(dto.taxNumber),
      // Canonical spelling, for the same reason the service areas above get it:
      // discovery compares a request's city and district against these as text.
      city: address.city,
      district: address.district,
      addressNote: normalizeNullableString(dto.addressNote),
      description: normalizeNullableString(dto.description),
      categoryIds,
      serviceAreas,
    };
  }

  /**
   * A provider may only newly select a category enrollment is open on: a live
   * service, or a draft an operator has opened to applications. See
   * isProviderEnrollmentOpen.
   *
   * Kind matters as much as status. A GROUP is a folder and a ROUTER is a
   * question — neither describes work anybody performs, so neither may end up
   * in a provider's service list, where it would silently never match a
   * request. Providers already attached to a category that later closes keep
   * their row; only new selections are refused.
   */
  private async ensureActiveCategories(categoryIds: string[]) {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, kind: true, status: true, providerEnrollmentOpen: true },
    });

    if (categories.length !== categoryIds.length) {
      throw new BadRequestException('Category IDs must reference active categories');
    }

    if (!categories.every((category) => canBeSelectedByProviders(category))) {
      throw new BadRequestException('Category IDs must reference active categories');
    }
  }

  private async ensureProviderExists(id: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id },
      // The status comes back so a caller can tell an actual transition from a
      // re-save of the state the row already had.
      select: { id: true, status: true },
    });

    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    return provider;
  }

  /**
   * Runs a notification and swallows whatever it throws.
   *
   * Every caller is past its commit point, so an escaping error could only turn
   * a completed action into a failed response. Transport failures are already
   * recorded in NotificationLog; this guards against a bug in the composing
   * code itself.
   */
  private async notify(run: () => Promise<unknown>, providerId: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a notification for provider ${providerId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async getProviderForUpdate(id: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id },
      select: { id: true, userId: true, email: true, claimedAt: true },
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
          // The single choke point for discovery, request detail and offering:
          // a DRAFT binding is release preparation, not supply, so it must not
          // put an admin's smoke-test request in front of a provider or let one
          // spend a credit on it. When the category is released the same row
          // starts matching here with nothing to migrate.
          where: { category: { status: { not: ServiceCategoryStatus.DRAFT } } },
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
        // kind, status and the enrollment switch travel with every binding
        // because they are what decides which of the two lists a binding lands
        // in — see visibleServiceCategories and upcomingServiceCategories.
        // Every non-admin projection narrows this back down.
        select: {
          id: true,
          name: true,
          slug: true,
          kind: true,
          status: true,
          providerEnrollmentOpen: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
  serviceAreas: {
    orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
  },
} satisfies Prisma.ProviderProfileInclude;

/**
 * The binding shape everyone who is not an operator sees.
 *
 * Two jobs in one function, and they belong together: DRAFT bindings are
 * dropped, and the surviving ones are narrowed back to the exact
 * `{ id, category: { id, name, slug } }` shape every caller written before this
 * change already speaks. The narrowing is not cosmetic — `status` on a category
 * would newly tell a stranger that a service has been closed, which the public
 * catalogue does not say either.
 *
 * Applied on the way out of the service rather than in each query, so a future
 * read path that forgets it is a path that returns *more* rows than it should
 * and is caught by the leak tests, instead of one that silently omits the
 * filter in a `where` nobody reviews.
 */
type ProviderCategoryBinding = {
  id: string;
  category: {
    id: string;
    name: string;
    slug: string;
    kind: ServiceCategoryKind;
    status: ServiceCategoryStatus;
    providerEnrollmentOpen: boolean;
  };
};

function visibleServiceCategories(
  bindings: readonly ProviderCategoryBinding[],
): Array<{ id: string; category: { id: string; name: string; slug: string } }> {
  return bindings
    .filter((binding) => isLiveProviderBinding(binding.category))
    .map((binding) => ({
      id: binding.id,
      category: {
        id: binding.category.id,
        name: binding.category.name,
        slug: binding.category.slug,
      },
    }));
}

/**
 * The DRAFT half of the same bindings, in the same narrowed shape.
 *
 * Its own list rather than a flag on the one above, and that separation is the
 * contract: everything downstream — matching, offering, e-mail — reads
 * `serviceCategories`, and a draft appearing there would put a provider in
 * front of requests for a service that takes none. This list is read by a panel
 * and by nothing else.
 *
 * It exists because a provider can now make this binding themselves. Before,
 * only an operator could, so hiding it cost the provider nothing; now a
 * category that vanished the moment it was chosen would read as a bug rather
 * than as a release process.
 *
 * Which is exactly why it is bounded by enrollment rather than by DRAFT alone.
 * A draft an operator opened is one this provider could have chosen and can
 * already see on their own application form — naming it back to them discloses
 * nothing. A draft still closed to applications is the unreleased catalogue:
 * the operator bound them to it while preparing a service nobody has announced,
 * and it stays as invisible to them as it was before any of this.
 */
function upcomingServiceCategories(
  bindings: readonly ProviderCategoryBinding[],
): Array<{ id: string; category: { id: string; name: string; slug: string } }> {
  return bindings
    .filter(
      (binding) =>
        !isLiveProviderBinding(binding.category) && isProviderEnrollmentOpen(binding.category),
    )
    .map((binding) => ({
      id: binding.id,
      category: {
        id: binding.category.id,
        name: binding.category.name,
        slug: binding.category.slug,
      },
    }));
}

/**
 * The same narrowing, over a whole provider record, plus the drafts in their
 * own list.
 *
 * Used for the owner and the operator, and never for the public shape — which
 * toPublicProvider builds as its own allow-list and which carries no draft at
 * all.
 */
function withVisibleServiceCategories<
  T extends { serviceCategories: readonly ProviderCategoryBinding[] },
>(provider: T) {
  return {
    ...provider,
    serviceCategories: visibleServiceCategories(provider.serviceCategories),
    upcomingServiceCategories: upcomingServiceCategories(provider.serviceCategories),
  };
}

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
    // Narrowed here as well as at the owner branch: this function is the
    // allow-list for the public shape, so the rule has to be readable in it.
    serviceCategories: visibleServiceCategories(provider.serviceCategories),
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

  // Guest applications have no owner yet: an anonymous or third-party edit is
  // never allowed, and an applicant reaches their own application by claiming
  // it — which makes them the owner — not by editing it as a stranger.
  if (!provider.userId) {
    throw new ForbiddenException('Unclaimed provider profiles can only be updated by an admin');
  }

  if (user.role !== UserRole.PROVIDER || user.id !== provider.userId) {
    throw new ForbiddenException('Provider access denied');
  }
}

/**
 * Whether the application about to be written will have no owning account.
 *
 * A signed-in PROVIDER owns whatever they create; everybody else — an
 * anonymous visitor, and an operator submitting on somebody's behalf — produces
 * an application nobody owns yet, which is exactly what the claim flow hands
 * over later. The rule is stated once here because it decides two things that
 * must never disagree: whether a contact address is mandatory, and whether a
 * claim invitation is issued.
 */
function willBeUnownedApplication(user: AuthUser | null): boolean {
  return user?.role !== UserRole.PROVIDER;
}

/**
 * The one write failure an application has that is not a programming error.
 *
 * P2002 here can only be the unique index on ProviderProfile.userId — two
 * requests from the same provider account racing each other past the read in
 * {@link ProvidersService.prepareApplication}. The database is the source of
 * truth for that rule; this turns its refusal into the same 409 the read
 * produces, rather than a 500.
 */
function translateApplicationWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException('Bu hesap için zaten bir hizmet veren profili var.');
  }

  return error;
}

/**
 * A guest application must be reachable, or nobody can ever be given it.
 *
 * Only enforced while PROVIDER_CLAIM_ENABLED is on and only for applications
 * that will have no owner: with the flag off the address stays as optional as
 * it has always been, so nothing about today's guest form changes.
 */
function requireClaimableApplicationEmail(email: string | null) {
  if (!email) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: PROVIDER_EMAIL_REQUIRED_CODE,
      message: 'Başvuruyu hesabınıza bağlayabilmemiz için e-posta adresi gerekli.',
    });
  }

  if (!isValidProviderEmail(email)) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      code: PROVIDER_EMAIL_REQUIRED_CODE,
      message: 'Geçerli bir e-posta adresi girin.',
    });
  }
}

/**
 * A *claimed* profile's contact address is frozen.
 *
 * The lock exists for one reason: a claim grants ownership by proving control
 * of exactly this address, and the new account's own e-mail is set equal to it
 * at that moment. Letting either side move afterwards would point a later
 * invitation — or a support conversation driven off the application — at
 * somebody who is not the owner. Admins are not exempt; the invariant protects
 * the owner, not the operator.
 *
 * `claimedAt`, not `userId`, is what that reasoning is about. A profile created
 * by a provider who was already signed in was never claimed and never had an
 * address vouched for, so freezing it would be a rule with no argument behind
 * it — and a retroactive one: such a profile may legitimately carry no address
 * at all, and the lock would leave it unable to ever gain one. Those profiles
 * keep the editing behaviour they have always had.
 *
 * Unclaimed applications also stay editable, which is the supported way to fix
 * an address that was typed wrong before a fresh invitation is issued.
 *
 * Comparison is case-insensitive, so re-submitting an unchanged legacy value is
 * not a change; clearing the address is one, and is refused like any other.
 */
function ensureContactEmailStable(
  provider: { claimedAt: Date | null; email: string | null },
  nextEmail: string | null,
) {
  if (!provider.claimedAt || sameProviderEmail(provider.email, nextEmail)) {
    return;
  }

  throw new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PROVIDER_EMAIL_IMMUTABLE_CODE,
    message:
      'Sahiplenilmiş bir başvurunun e-posta adresi değiştirilemez. Diğer bilgileri güncelleyebilirsiniz.',
  });
}

/**
 * What a provider sees of the request its own offer sits on.
 *
 * City and district and no finer: those two are what the offer was priced
 * against and what discovery matched on, so the provider already had them. The
 * neighbourhood used to be here too, on every offer of every status, which made
 * this a second and much quieter answer to a question the contact-sharing flow
 * is supposed to own — that flow decides whether a provider learns where the
 * customer actually is, behind its own flag, its own disclosure and its own
 * audit row. Nothing rendered it, so it left silently.
 */
const providerOfferInclude = {
  request: {
    select: {
      id: true,
      requestNumber: true,
      city: true,
      district: true,
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

/**
 * The business address, in the canonical spelling of the shipped location list.
 *
 * The DTO already refused a pair that does not exist; this is what stops
 * "istanbul" and "İstanbul" from becoming two different places on a screen that
 * lists providers by city.
 */
function normalizeBusinessAddress(dto: Pick<CreateProviderDto, 'city' | 'district'>) {
  const resolved = resolveLocation({
    city: normalizeRequiredString(dto.city, 'City'),
    district: normalizeRequiredString(dto.district, 'District'),
  });

  if (!resolved) {
    throw new BadRequestException(
      'Seçilen il ve ilçe birlikte geçerli bir adres oluşturmuyor.',
    );
  }

  return { city: resolved.city, district: resolved.district };
}

/**
 * Every service area an application carries, canonical, scoped and checked
 * against each other.
 *
 * Three refusals, and they are three different mistakes:
 *
 *  - an area that names no real place — discovery compares these against a
 *    request as plain text, so an area at a place that does not exist is an
 *    area that matches nothing, silently and forever;
 *  - the same area twice, which the three partial unique indexes refuse at the
 *    database as well;
 *  - an area already covered by a wider one in the same list, or a wider one
 *    added over areas it swallows. "İstanbul geneli" plus "İstanbul/Kadıköy" is
 *    not richer coverage than "İstanbul geneli" alone — it is the same coverage
 *    with a row that can only ever mislead whoever reads the profile next.
 *
 * `alreadyStored` is what the provider's profile holds right now, and it exists
 * so the third refusal only ever refuses something *new*. A profile that came
 * out of the migration holding an overlapping pair keeps it — the migration
 * deletes nothing — and its owner must be able to open that form, change a
 * phone number and save. So an overlap whose both halves are already stored is
 * let through untouched, and the provider removes it from the list when they
 * decide to, with the remove button beside it. Creating a profile passes
 * nothing here, so nothing is grandfathered into a new one.
 *
 * The scope is decided here and nowhere else, from the levels that resolved.
 */
function normalizeServiceAreas(
  serviceAreas: ProviderServiceAreaDto[],
  alreadyStored: readonly ScopedArea[] = [],
) {
  if (!Array.isArray(serviceAreas) || serviceAreas.length === 0) {
    throw new BadRequestException('En az bir hizmet bölgesi eklemelisiniz.');
  }

  const normalized = serviceAreas.map((area) => {
    // Canonical, because discovery matches these against a request's own
    // canonical city and district as text. A district left out still means the
    // whole province, exactly as it did before.
    const resolved = resolveArea({
      city: normalizeRequiredString(area.city, 'Service area city'),
      district: normalizeNullableString(area.district),
      neighborhood: normalizeNullableString(area.neighborhood),
    });

    if (!resolved) {
      throw new BadRequestException(
        'Seçilen hizmet bölgesi geçerli bir il/ilçe/mahalle birleşimi değil.',
      );
    }

    return resolved;
  });

  assertNewAreasAreDistinctAndUncovered(normalized, alreadyStored);

  return normalized.map(toServiceAreaRow);
}

/**
 * The pairwise check behind the two "you already have this" refusals.
 *
 * Quadratic on purpose: the list is the areas one business ticked on one form,
 * and a message that names the offending pair is worth far more here than an
 * index would be.
 *
 * The duplicate check is absolute — the same area written twice in one payload
 * is a row the database would refuse anyway, and no stored profile can hold one
 * because the migration stops rather than create a table that does. The overlap
 * check is not: a pair both of whose halves are already stored is a pair this
 * save did not create, and refusing it would lock its owner out of their own
 * profile until they worked out which of their rows the API disliked.
 */
function assertNewAreasAreDistinctAndUncovered(
  areas: readonly ScopedArea[],
  alreadyStored: readonly ScopedArea[],
) {
  const isStored = (area: ScopedArea) =>
    alreadyStored.some((stored) => areaCovers(stored, area) && areaCovers(area, stored));

  for (const [i, first] of areas.entries()) {
    for (const second of areas.slice(i + 1)) {
      if (areaCovers(first, second) && areaCovers(second, first)) {
        throw new BadRequestException(
          `Aynı hizmet bölgesini iki kez ekleyemezsiniz: ${describeArea(first)}.`,
        );
      }

      const overlaps = areaCovers(first, second) || areaCovers(second, first);
      if (!overlaps || (isStored(first) && isStored(second))) {
        continue;
      }

      const [wider, narrower] = areaCovers(first, second) ? [first, second] : [second, first];
      throw new BadRequestException(
        `${describeArea(wider)} zaten ${describeArea(narrower)} bölgesini kapsıyor. İkisini birlikte ekleyemezsiniz.`,
      );
    }
  }
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

function normalizeOptionalOwnership(value: string | undefined): ProviderOwnershipFilter | null {
  const normalized = normalizeNullableString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized !== 'claimed' && normalized !== 'unclaimed') {
    throw new BadRequestException('ownership must be claimed or unclaimed');
  }

  return normalized;
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
          unviewedRefundPolicy: true;
          unviewedRefundWindowHours: true;
          unviewedRefundEligibleAt: true;
          refundBlockedAt: true;
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
  // Two internal fields are dropped rather than reworded.
  //
  // rejectionReason: COMPETITOR_ACCEPTED tells the provider that somebody else
  // won, which is exactly what the provider must not learn.
  //
  // creditRefundReason: for a manual refund this is the operations code an
  // administrator filed the case under — "CUSTOMER_UNREACHABLE",
  // "PLATFORM_ERROR" — which is an internal judgement about a case, not
  // something the provider is owed an explanation in. What stays is the fact
  // and its date: refundEligibility reports "Kredi iade edildi", and
  // creditRefundedAt says when.
  const { rejectionReason, creditRefundReason, ...visible } = offer;
  void rejectionReason;
  void creditRefundReason;

  return {
    ...visible,
    refundEligibility: calculateRefundEligibility(offer),
  };
}

type RefundPolicyOfferShape = {
  submittedAt: Date | string | null;
  viewedAt: Date | string | null;
  creditCost: number;
  creditSpentTransactionId: string | null;
  creditRefundedTransactionId: string | null;
  creditRefundedAt: Date | string | null;
  // Required: a provider screen that renders a refund verdict must state
  // whether the offer is inside the policy at all.
  unviewedRefundPolicy: boolean;
  // Required for the same reason: without it an offer an administrator has
  // already decided would read to its provider as "Görüntülenme bekleniyor",
  // which is a refund promise the worker will not keep.
  refundBlockedAt: Date | string | null;
  // Required for the same reason again: the window and the moment are what the
  // screen quotes back to the provider, and a projection that forgets them
  // would report an in-policy offer as having no refund schedule at all.
  unviewedRefundWindowHours: number | null;
  unviewedRefundEligibleAt: Date | string | null;
  rejectionReason?: OfferRejectionReason | null;
  creditRefundReason?: string | null;
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
