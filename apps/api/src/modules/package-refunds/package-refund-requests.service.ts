import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminPermission,
  PackagePurchaseKind,
  PackagePurchaseStatus,
  PackageRefundActorKind,
  PackageRefundApprovalKind,
  PackageRefundAuditAction,
  PackageRefundExceptionGround,
  PackageRefundRequestOrigin,
  PackageRefundRequestStatus,
  Prisma,
  SupportTicketAuthorRole,
  SupportTicketRequesterRole,
  SupportTicketStatus,
  SupportTicketTopic,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { hasPermission } from '../auth/admin-permissions';
import type { AuthUser } from '../auth/auth.types';
import {
  enqueuePackageRefundNotice,
  PackageRefundNotificationOutbox,
} from '../notifications/package-refund-notification-outbox.service';
import { SUPPORT_TICKET_SUBJECT_MAX_LENGTH } from '../support-tickets/support-tickets.config';
import {
  evaluatePackageRefundEligibility,
  PACKAGE_REFUND_WINDOW_MS,
  type PackageRefundEligibility,
} from './package-refund-eligibility';
import { PackageRefundEligibilityService } from './package-refund-eligibility.service';
import {
  refundAlreadyOpen,
  refundExceptionNotNeeded,
  refundInvalidTransition,
  refundMakerChecker,
  refundNotApplicable,
  refundNotEligible,
  refundNotNormallyEligible,
  refundTicketAlreadyLinked,
  refundTicketNotEligible,
  refundUnavailableForOperator,
  refundUnavailableForProvider,
} from './package-refund-request.errors';
import {
  adminRefundDetailSelect,
  adminRefundListSelect,
  providerRefundSelect,
  toAdminRefundDetail,
  toAdminRefundListItem,
  toProviderRefundRequest,
  toRefundTimelineEvent,
  refundEventSelect,
  type RefundTimelineAudience,
} from './package-refund-request.projection';
import {
  isPackageRefundFlowOpen,
  isPurchaseTermsTestMode,
  OPEN_REFUND_STATUSES,
  purchaseCarriesTermsEvidence,
  WITHDRAWABLE_STATUSES,
} from './package-refund-request.rules';
import {
  PACKAGE_REFUND_PAGE_DEFAULT_SIZE,
  PACKAGE_REFUND_PAGE_MAX_SIZE,
  type ApprovePackageRefundRequestDto,
  type ListPackageRefundRequestsDto,
} from './dto/admin-package-refund.dto';

/** What an eligibility result is stored as: a plain JSON object. */
function asJson(eligibility: PackageRefundEligibility): Prisma.InputJsonValue {
  return eligibility as unknown as Prisma.InputJsonValue;
}

type Tx = Prisma.TransactionClient;

/** The purchase columns every rule in this file reads, and nothing else. */
const purchaseRuleSelect = {
  id: true,
  providerId: true,
  kind: true,
  status: true,
  termsAcceptanceRequired: true,
  purchaseTermsAcceptanceId: true,
  packageNameSnapshot: true,
  purchaseNumber: true,
} satisfies Prisma.PackagePurchaseSelect;

/**
 * CMP-006 PR-B — the package refund request and its state machine.
 *
 * **A review record, never a payment.** Nothing here calls a payment provider,
 * writes a ledger row, touches a balance or a promo lot. The money moves in the
 * payment provider's panel, outside TakTic; the only way to SETTLED is
 * `PackageRefundSettlementService`, called from inside the signed
 * `order_refunded` webhook transaction. There is no method here that writes
 * SETTLED, and the database would refuse one that tried.
 *
 * **Three sides, three entry points.** The provider opens a request from the
 * support form (inside the ticket's own transaction) and may withdraw it; the
 * operator opens one on a provider's existing ticket, takes it into review,
 * approves, rejects or records a failed settlement. Every transition is a
 * compare-and-swap on the current status, writes one audit row, and moves the
 * ticket's activity mark so the conversation shows it.
 *
 * **Fail-closed.** Creating, taking and approving need the purchase-terms gate
 * open and the purchase's acceptance evidence. Rejecting, withdrawing and
 * recording a failed settlement do not: closing the gate later must not strand
 * the requests already open.
 */
@Injectable()
export class PackageRefundRequestsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PackageRefundEligibilityService)
    private readonly eligibility: PackageRefundEligibilityService,
    @Inject(PackageRefundNotificationOutbox)
    private readonly notices: PackageRefundNotificationOutbox,
  ) {}

  // ---------------------------------------------------------------------------
  // Provider
  // ---------------------------------------------------------------------------

  /**
   * What the support form may offer: nothing at all with the flow closed, and
   * otherwise only the caller's own purchases a normal refund request can be
   * opened for *right now* (PR-B.1) — PAID credit packages bought with terms
   * evidence, with no open request, that the canonical evaluation calls
   * REFUNDABLE. `available` is false when that list is empty, and then the
   * form offers no refund type at all.
   *
   * Each item carries the subject the ticket will get, so the form can show
   * it without composing it: the subject is the server's, never the caller's.
   * `testMode` is true only under `PURCHASE_TERMS_GATE=test`.
   */
  async providerOptions(user: AuthUser) {
    const closed = { available: false as const, testMode: false, purchases: [] };
    if (!isPackageRefundFlowOpen()) {
      return closed;
    }

    const provider = await this.ownProvider(user);
    if (!provider) {
      return closed;
    }

    const purchases = await this.requestablePurchases(provider.id, new Date());
    return {
      available: purchases.length > 0,
      testMode: isPurchaseTermsTestMode(),
      purchases,
    };
  }

  /**
   * PR-B.1 — whether the caller may open a normal refund request for this one
   * purchase now: the same rules as {@link providerOptions}, for the "İade
   * talebi oluştur" button on the purchase's own page. Answers a bare boolean
   * and the same `false` for a closed flow, a customer, an invented id,
   * another provider's purchase and an ineligible one of their own, so the
   * answer tells nobody anything about a purchase that is not theirs.
   */
  async providerPurchaseAvailability(user: AuthUser, purchaseId: string) {
    if (!isPackageRefundFlowOpen()) {
      return { available: false };
    }
    const provider = await this.ownProvider(user);
    if (!provider) {
      return { available: false };
    }
    const purchases = await this.requestablePurchases(provider.id, new Date(), purchaseId);
    return { available: purchases.length > 0 };
  }

  /**
   * The provider's purchases a normal refund request can be opened for at
   * `now`. The query narrows to the candidates — own, PAID credit packages
   * with evidence, paid inside the window, no open request — and the
   * canonical evaluation decides each one; the narrowing can only drop a
   * purchase the evaluation would refuse anyway.
   */
  private async requestablePurchases(providerId: string, now: Date, onlyPurchaseId?: string) {
    const purchases = await this.prisma.packagePurchase.findMany({
      where: {
        ...(onlyPurchaseId === undefined ? {} : { id: onlyPurchaseId }),
        providerId,
        kind: PackagePurchaseKind.OFFER_PACKAGE,
        status: PackagePurchaseStatus.PAID,
        termsAcceptanceRequired: true,
        purchaseTermsAcceptanceId: { not: null },
        paidAt: { gte: new Date(now.getTime() - PACKAGE_REFUND_WINDOW_MS) },
        packageRefundRequests: { none: { status: { in: [...OPEN_REFUND_STATUSES] } } },
      },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        purchaseNumber: true,
        packageNameSnapshot: true,
        creditAmountSnapshot: true,
        priceAmountSnapshot: true,
        currencySnapshot: true,
        paidAt: true,
      },
    });

    const items = [];
    for (const purchase of purchases) {
      const eligibility = await this.eligibility.evaluate(purchase.id, now);
      if (eligibility.recommendation !== 'REFUNDABLE') {
        continue;
      }
      items.push({
        id: purchase.id,
        purchaseNumber: purchase.purchaseNumber,
        packageName: purchase.packageNameSnapshot,
        creditAmount: purchase.creditAmountSnapshot,
        priceAmount: purchase.priceAmountSnapshot,
        currency: purchase.currencySnapshot,
        paidAt: purchase.paidAt ? purchase.paidAt.toISOString() : null,
        windowEndsAt: eligibility.windowEndsAt,
        ticketSubject: refundTicketSubject(purchase),
      });
    }
    return items;
  }

  /**
   * Opens a refund ticket: the ticket, its first message, the request and the
   * request's first audit row — one Serializable transaction, so none exists
   * without the others. Returns the ticket id; the caller projects it.
   *
   * The provider can only reach the normal flow: the canonical evaluation must
   * say REFUNDABLE at this instant. Anything else is refused with the blocking
   * codes and the general topic stays open to them.
   */
  async openProviderRefundTicket(user: AuthUser, input: { purchaseId: string; body: string }) {
    if (user.role !== UserRole.PROVIDER || !isPackageRefundFlowOpen()) {
      throw refundUnavailableForProvider();
    }

    const provider = await this.ownProvider(user);
    if (!provider) {
      throw new NotFoundException('Package purchase not found');
    }

    const now = new Date();

    try {
      const opened = await runSerializable(
        this.prisma,
        async (tx) => {
          // Ownership in the where clause: another provider's purchase id is the
          // same 404 as an invented one.
          const purchase = await tx.packagePurchase.findFirst({
            where: { id: input.purchaseId, providerId: provider.id },
            select: purchaseRuleSelect,
          });
          if (!purchase) {
            throw new NotFoundException('Package purchase not found');
          }
          if (!purchaseCarriesTermsEvidence(purchase)) {
            throw refundUnavailableForProvider();
          }

          const eligibility = await this.evaluateIn(tx, purchase.id, now);
          if (eligibility.recommendation !== 'REFUNDABLE') {
            throw refundNotEligible(eligibility.blockingCodes);
          }
          await this.assertNoOpenRequest(tx, purchase.id);

          const ticket = await tx.supportTicket.create({
            data: {
              requesterId: user.id,
              requesterRole: SupportTicketRequesterRole.PROVIDER,
              topic: SupportTicketTopic.PACKAGE_AND_CREDIT_REFUND,
              subject: refundTicketSubject(purchase),
              lastActivityAt: now,
              createdAt: now,
            },
            select: { id: true },
          });

          await tx.supportTicketMessage.create({
            data: {
              ticketId: ticket.id,
              authorUserId: user.id,
              authorRole: SupportTicketAuthorRole.PROVIDER,
              body: input.body,
              createdAt: now,
            },
          });

          const request = await tx.packageRefundRequest.create({
            data: {
              supportTicketId: ticket.id,
              purchaseId: purchase.id,
              providerId: provider.id,
              origin: PackageRefundRequestOrigin.PROVIDER,
              createdById: user.id,
              submittedEligibility: asJson(eligibility),
              submittedRecommendation: eligibility.recommendation,
              createdAt: now,
            },
            select: { id: true },
          });

          await this.audit(tx, {
            requestId: request.id,
            action: PackageRefundAuditAction.SUBMITTED,
            fromStatus: null,
            toStatus: PackageRefundRequestStatus.SUBMITTED,
            actorKind: PackageRefundActorKind.PROVIDER,
            actorId: user.id,
            now,
          });

          return { ticketId: ticket.id, requestId: request.id };
        },
        { label: 'packageRefunds.openProviderRefundTicket' },
      );
      this.notices.deliverSoon();
      return opened;
    } catch (error) {
      throw mapOpenRequestViolation(error);
    }
  }

  /** The provider's withdrawal, before any approval. Scoped to their own ticket. */
  async withdraw(user: AuthUser, ticketId: string) {
    const request = await this.prisma.packageRefundRequest.findFirst({
      where: {
        supportTicket: {
          id: ticketId,
          requesterId: user.id,
          requesterRole: SupportTicketRequesterRole.PROVIDER,
        },
      },
      select: { id: true, status: true, supportTicketId: true },
    });

    if (user.role !== UserRole.PROVIDER || !request) {
      throw new NotFoundException('Package refund request not found');
    }

    await this.transition(request, {
      from: WITHDRAWABLE_STATUSES,
      action: 'geri çekme',
      data: (now) => ({ status: PackageRefundRequestStatus.WITHDRAWN, withdrawnAt: now }),
      audit: {
        action: PackageRefundAuditAction.WITHDRAWN,
        toStatus: PackageRefundRequestStatus.WITHDRAWN,
        actorKind: PackageRefundActorKind.PROVIDER,
        actorId: user.id,
      },
    });

    return this.providerRequestForTicket(ticketId);
  }

  /** The provider's view of the request on one of their tickets (already ownership-checked). */
  async providerRequestForTicket(ticketId: string) {
    const request = await this.prisma.packageRefundRequest.findUnique({
      where: { supportTicketId: ticketId },
      select: providerRefundSelect,
    });
    return request ? toProviderRefundRequest(request) : null;
  }

  // ---------------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------------

  /**
   * The refund entries of one ticket's timeline. The provider audience gets
   * the transition and nothing else — no actor, no operator's reason.
   */
  async timelineEvents(ticketId: string, audience: RefundTimelineAudience) {
    const events = await this.prisma.packageRefundRequestEvent.findMany({
      where: { request: { supportTicketId: ticketId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: refundEventSelect,
    });
    return events.map((event) => toRefundTimelineEvent(event, audience));
  }

  // ---------------------------------------------------------------------------
  // Operator
  // ---------------------------------------------------------------------------

  async list(filters: ListPackageRefundRequestsDto) {
    const page = filters.page ?? 1;
    const pageSize = clampPageSize(filters.pageSize);
    const where: Prisma.PackageRefundRequestWhereInput = filters.status?.length
      ? { status: { in: filters.status } }
      : {};

    const [total, rows, grouped] = await Promise.all([
      this.prisma.packageRefundRequest.count({ where }),
      this.prisma.packageRefundRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: adminRefundListSelect,
      }),
      this.prisma.packageRefundRequest.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(PackageRefundRequestStatus).map((status) => [status, 0]),
    ) as Record<PackageRefundRequestStatus, number>;
    for (const row of grouped) {
      statusCounts[row.status] = row._count._all;
    }

    return {
      items: rows.map(toAdminRefundListItem),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
      statusCounts,
    };
  }

  async detail(id: string, viewer: AuthUser) {
    const request = await this.prisma.packageRefundRequest.findUnique({
      where: { id },
      select: adminRefundDetailSelect,
    });
    if (!request) {
      throw new NotFoundException('Package refund request not found');
    }

    const [events, evidence, currentEligibility] = await Promise.all([
      this.prisma.packageRefundRequestEvent.findMany({
        where: { requestId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: refundEventSelect,
      }),
      // Two columns of the acceptance, and only these: which text version was
      // accepted and when. Never the snapshot, the digest, the address or the
      // user agent.
      request.purchase.purchaseTermsAcceptanceId
        ? this.prisma.purchaseTermsAcceptance.findUnique({
            where: { id: request.purchase.purchaseTermsAcceptanceId },
            select: { documentVersion: true, acceptedAt: true },
          })
        : Promise.resolve(null),
      this.eligibility.evaluate(request.purchaseId),
    ]);

    const flowOpen = isPackageRefundFlowOpen();
    const hasEvidence = purchaseCarriesTermsEvidence(request.purchase);
    const can = (permission: AdminPermission) =>
      hasPermission({ role: viewer.role, permissions: viewer.permissions ?? [] }, [permission]);
    const isMakerOrReviewer =
      viewer.id === request.createdById || viewer.id === request.reviewStartedById;
    const underReview = request.status === PackageRefundRequestStatus.UNDER_REVIEW;
    const approveReady = underReview && flowOpen && hasEvidence && can(AdminPermission.PACKAGE_REFUND_APPROVE);

    return {
      ...toAdminRefundDetail(request, events, evidence),
      currentEligibility,
      flowOpen,
      allowedActions: {
        take:
          request.status === PackageRefundRequestStatus.SUBMITTED &&
          flowOpen &&
          hasEvidence &&
          can(AdminPermission.PACKAGE_REFUND_REQUEST_CREATE),
        approveNormal: approveReady && currentEligibility.recommendation === 'REFUNDABLE',
        approveException:
          approveReady && currentEligibility.recommendation === 'EXCEPTION_ONLY' && !isMakerOrReviewer,
        reject: underReview && can(AdminPermission.PACKAGE_REFUND_APPROVE),
        markSettlementFailed:
          request.status === PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT &&
          can(AdminPermission.PACKAGE_REFUND_APPROVE),
      },
      /** True when only the maker-checker rule keeps this viewer from an exception approval. */
      exceptionBlockedByMakerChecker:
        approveReady && currentEligibility.recommendation === 'EXCEPTION_ONLY' && isMakerOrReviewer,
    };
  }

  /**
   * An operator opening a request on a provider's *own, existing* ticket — the
   * way an exception case starts, since the provider's form only takes
   * REFUNDABLE purchases. No ticket is created: the admin side cannot open a
   * ticket in anybody's name.
   */
  async createByAdmin(admin: AuthUser, input: { supportTicketId: string; purchaseId: string }) {
    if (!isPackageRefundFlowOpen()) {
      throw refundUnavailableForOperator();
    }

    const now = new Date();

    try {
      const created = await runSerializable(
        this.prisma,
        async (tx) => {
          const ticket = await tx.supportTicket.findUnique({
            where: { id: input.supportTicketId },
            select: {
              id: true,
              status: true,
              requesterId: true,
              requesterRole: true,
              packageRefundRequest: { select: { id: true } },
            },
          });
          if (!ticket) {
            throw new NotFoundException('Support ticket not found');
          }
          if (
            ticket.requesterRole !== SupportTicketRequesterRole.PROVIDER ||
            ticket.status === SupportTicketStatus.CLOSED
          ) {
            throw refundTicketNotEligible();
          }
          if (ticket.packageRefundRequest) {
            throw refundTicketAlreadyLinked();
          }

          const provider = await tx.providerProfile.findUnique({
            where: { userId: ticket.requesterId },
            select: { id: true },
          });
          const purchase = provider
            ? await tx.packagePurchase.findFirst({
                where: { id: input.purchaseId, providerId: provider.id },
                select: purchaseRuleSelect,
              })
            : null;
          if (!provider || !purchase) {
            // The ticket owner's purchase or nothing: a purchase of another
            // provider is not a thing this ticket can name.
            throw new NotFoundException('Package purchase not found');
          }
          if (!purchaseCarriesTermsEvidence(purchase)) {
            throw refundUnavailableForOperator();
          }

          const eligibility = await this.evaluateIn(tx, purchase.id, now);
          if (eligibility.recommendation === 'NOT_APPLICABLE') {
            throw refundNotApplicable(eligibility.blockingCodes);
          }
          await this.assertNoOpenRequest(tx, purchase.id);

          const request = await tx.packageRefundRequest.create({
            data: {
              supportTicketId: ticket.id,
              purchaseId: purchase.id,
              providerId: provider.id,
              origin: PackageRefundRequestOrigin.ADMIN,
              createdById: admin.id,
              submittedEligibility: asJson(eligibility),
              submittedRecommendation: eligibility.recommendation,
              createdAt: now,
            },
            select: { id: true },
          });

          await this.audit(tx, {
            requestId: request.id,
            action: PackageRefundAuditAction.SUBMITTED,
            fromStatus: null,
            toStatus: PackageRefundRequestStatus.SUBMITTED,
            actorKind: PackageRefundActorKind.ADMIN,
            actorId: admin.id,
            now,
          });
          await touchTicket(tx, ticket.id, now);

          return request.id;
        },
        { label: 'packageRefunds.createByAdmin' },
      );
      this.notices.deliverSoon();
      return this.detail(created, admin);
    } catch (error) {
      throw mapOpenRequestViolation(error);
    }
  }

  async take(id: string, admin: AuthUser) {
    const request = await this.loadForTransition(id);
    if (!isPackageRefundFlowOpen() || !purchaseCarriesTermsEvidence(request.purchase)) {
      throw refundUnavailableForOperator();
    }

    await this.transition(request, {
      from: [PackageRefundRequestStatus.SUBMITTED],
      action: 'işleme alma',
      data: (now) => ({
        status: PackageRefundRequestStatus.UNDER_REVIEW,
        reviewStartedById: admin.id,
        reviewStartedAt: now,
      }),
      audit: {
        action: PackageRefundAuditAction.REVIEW_STARTED,
        toStatus: PackageRefundRequestStatus.UNDER_REVIEW,
        actorKind: PackageRefundActorKind.ADMIN,
        actorId: admin.id,
      },
    });

    return this.detail(id, admin);
  }

  /**
   * Approval, with the eligibility recomputed inside the approving transaction
   * — the one the decision is stored with. Serializable, so a spend or a
   * reversal webhook committing concurrently either precedes this read or
   * makes this transaction retry; it cannot slip between the check and the
   * write.
   */
  async approve(id: string, admin: AuthUser, dto: ApprovePackageRefundRequestDto) {
    const kind = dto.kind;
    if (
      kind === PackageRefundApprovalKind.NORMAL &&
      (dto.exceptionGround !== undefined || dto.exceptionReason !== undefined)
    ) {
      throw new BadRequestException('Normal onay istisna gerekçesi taşımaz.');
    }
    const ground: PackageRefundExceptionGround | null =
      kind === PackageRefundApprovalKind.EXCEPTION ? (dto.exceptionGround ?? null) : null;
    const reason = kind === PackageRefundApprovalKind.EXCEPTION ? (dto.exceptionReason ?? null) : null;

    if (!isPackageRefundFlowOpen()) {
      throw refundUnavailableForOperator();
    }

    const now = new Date();

    await runSerializable(
      this.prisma,
      async (tx) => {
        const request = await tx.packageRefundRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            purchaseId: true,
            supportTicketId: true,
            createdById: true,
            reviewStartedById: true,
            purchase: { select: purchaseRuleSelect },
          },
        });
        if (!request) {
          throw new NotFoundException('Package refund request not found');
        }
        if (request.status !== PackageRefundRequestStatus.UNDER_REVIEW) {
          throw refundInvalidTransition(request.status, 'onay');
        }
        if (!purchaseCarriesTermsEvidence(request.purchase)) {
          throw refundUnavailableForOperator();
        }

        const eligibility = await this.evaluateIn(tx, request.purchaseId, now);
        if (eligibility.recommendation === 'NOT_APPLICABLE') {
          throw refundNotApplicable(eligibility.blockingCodes);
        }
        if (kind === PackageRefundApprovalKind.NORMAL && eligibility.recommendation !== 'REFUNDABLE') {
          throw refundNotNormallyEligible(eligibility.blockingCodes);
        }
        if (kind === PackageRefundApprovalKind.EXCEPTION) {
          if (eligibility.recommendation === 'REFUNDABLE') {
            throw refundExceptionNotNeeded();
          }
          if (admin.id === request.createdById || admin.id === request.reviewStartedById) {
            throw refundMakerChecker();
          }
        }

        const swapped = await tx.packageRefundRequest.updateMany({
          where: { id: request.id, status: PackageRefundRequestStatus.UNDER_REVIEW },
          data: {
            status: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
            approvalKind: kind,
            exceptionGround: ground,
            exceptionReason: reason,
            approvalEligibility: asJson(eligibility),
            approvedById: admin.id,
            approvedAt: now,
          },
        });
        if (swapped.count !== 1) {
          throw refundInvalidTransition(request.status, 'onay');
        }

        await this.audit(tx, {
          requestId: request.id,
          action: PackageRefundAuditAction.APPROVED,
          fromStatus: PackageRefundRequestStatus.UNDER_REVIEW,
          toStatus: PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT,
          actorKind: PackageRefundActorKind.ADMIN,
          actorId: admin.id,
          note: reason,
          now,
        });
        await touchTicket(tx, request.supportTicketId, now);
      },
      { label: 'packageRefunds.approve' },
    );
    this.notices.deliverSoon();

    return this.detail(id, admin);
  }

  async reject(id: string, admin: AuthUser, reason: string) {
    const request = await this.loadForTransition(id);
    await this.transition(request, {
      from: [PackageRefundRequestStatus.UNDER_REVIEW],
      action: 'ret',
      data: (now) => ({
        status: PackageRefundRequestStatus.REJECTED,
        rejectedById: admin.id,
        rejectedAt: now,
        rejectionReason: reason,
      }),
      audit: {
        action: PackageRefundAuditAction.REJECTED,
        toStatus: PackageRefundRequestStatus.REJECTED,
        actorKind: PackageRefundActorKind.ADMIN,
        actorId: admin.id,
        note: reason,
      },
    });
    return this.detail(id, admin);
  }

  /**
   * The only way out of APPROVED_PENDING_SETTLEMENT that is not the webhook:
   * the external refund did not happen, or its webhook never came. It moves no
   * money and no credit — it is the record that the approval did not settle.
   */
  async markSettlementFailed(id: string, admin: AuthUser, reason: string) {
    const request = await this.loadForTransition(id);
    await this.transition(request, {
      from: [PackageRefundRequestStatus.APPROVED_PENDING_SETTLEMENT],
      action: 'ödeme iadesi tamamlanamadı kaydı',
      data: (now) => ({
        status: PackageRefundRequestStatus.SETTLEMENT_FAILED,
        settlementFailedById: admin.id,
        settlementFailedAt: now,
        settlementFailureReason: reason,
      }),
      audit: {
        action: PackageRefundAuditAction.SETTLEMENT_FAILED,
        toStatus: PackageRefundRequestStatus.SETTLEMENT_FAILED,
        actorKind: PackageRefundActorKind.ADMIN,
        actorId: admin.id,
        note: reason,
      },
    });
    return this.detail(id, admin);
  }

  /**
   * The refund block of the admin ticket screen, for a viewer who may read
   * refunds (the caller checks). `candidatePurchases` is filled only when this
   * viewer may open a request here right now.
   */
  async adminTicketBlock(
    ticket: { id: string; status: SupportTicketStatus; requesterId: string; requesterRole: SupportTicketRequesterRole },
    viewer: AuthUser,
  ) {
    const request = await this.prisma.packageRefundRequest.findUnique({
      where: { supportTicketId: ticket.id },
      select: { id: true, status: true },
    });

    const canOpen =
      !request &&
      isPackageRefundFlowOpen() &&
      ticket.requesterRole === SupportTicketRequesterRole.PROVIDER &&
      ticket.status !== SupportTicketStatus.CLOSED &&
      hasPermission({ role: viewer.role, permissions: viewer.permissions ?? [] }, [
        AdminPermission.PACKAGE_REFUND_REQUEST_CREATE,
      ]);

    let candidatePurchases: {
      id: string;
      purchaseNumber: string | null;
      packageName: string;
      priceAmount: number;
      currency: string;
      paidAt: string | null;
      recommendation: string;
    }[] = [];

    if (canOpen) {
      const provider = await this.prisma.providerProfile.findUnique({
        where: { userId: ticket.requesterId },
        select: { id: true },
      });
      if (provider) {
        const purchases = await this.prisma.packagePurchase.findMany({
          where: {
            providerId: provider.id,
            kind: PackagePurchaseKind.OFFER_PACKAGE,
            status: PackagePurchaseStatus.PAID,
            termsAcceptanceRequired: true,
            purchaseTermsAcceptanceId: { not: null },
          },
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          take: 50,
          select: {
            id: true,
            purchaseNumber: true,
            packageNameSnapshot: true,
            priceAmountSnapshot: true,
            currencySnapshot: true,
            paidAt: true,
          },
        });
        const now = new Date();
        for (const purchase of purchases) {
          const eligibility = await this.eligibility.evaluate(purchase.id, now);
          if (eligibility.recommendation === 'NOT_APPLICABLE') continue;
          candidatePurchases.push({
            id: purchase.id,
            purchaseNumber: purchase.purchaseNumber,
            packageName: purchase.packageNameSnapshot,
            priceAmount: purchase.priceAmountSnapshot,
            currency: purchase.currencySnapshot,
            paidAt: purchase.paidAt ? purchase.paidAt.toISOString() : null,
            recommendation: eligibility.recommendation,
          });
        }
      }
    }

    return { request, canOpen: canOpen && candidatePurchases.length > 0, candidatePurchases };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async ownProvider(user: AuthUser) {
    if (user.role !== UserRole.PROVIDER) {
      return null;
    }
    return this.prisma.providerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
  }

  private async evaluateIn(tx: Tx, purchaseId: string, now: Date) {
    const facts = await this.eligibility.readFacts(tx, purchaseId);
    if (!facts) {
      throw new NotFoundException('Package purchase not found');
    }
    return evaluatePackageRefundEligibility(facts, now);
  }

  private async assertNoOpenRequest(tx: Tx, purchaseId: string) {
    const open = await tx.packageRefundRequest.findFirst({
      where: { purchaseId, status: { in: [...OPEN_REFUND_STATUSES] } },
      select: { id: true },
    });
    if (open) {
      throw refundAlreadyOpen();
    }
  }

  private async loadForTransition(id: string) {
    const request = await this.prisma.packageRefundRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        supportTicketId: true,
        purchase: { select: purchaseRuleSelect },
      },
    });
    if (!request) {
      throw new NotFoundException('Package refund request not found');
    }
    return request;
  }

  /**
   * One compare-and-swap transition: the update matches only while the row is
   * still in an allowed status, the audit row and the ticket's activity mark
   * are written in the same transaction, and a lost race is a 409 naming the
   * status the row actually holds.
   */
  private async transition(
    request: { id: string; status: PackageRefundRequestStatus; supportTicketId: string },
    spec: {
      from: readonly PackageRefundRequestStatus[];
      action: string;
      data: (now: Date) => Prisma.PackageRefundRequestUpdateManyMutationInput & {
        status: PackageRefundRequestStatus;
      };
      audit: {
        action: PackageRefundAuditAction;
        toStatus: PackageRefundRequestStatus;
        actorKind: PackageRefundActorKind;
        actorId: string;
        note?: string | null;
      };
    },
  ) {
    if (!spec.from.includes(request.status)) {
      throw refundInvalidTransition(request.status, spec.action);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const swapped = await tx.packageRefundRequest.updateMany({
        where: { id: request.id, status: { in: [...spec.from] } },
        data: spec.data(now),
      });
      if (swapped.count !== 1) {
        const current = await tx.packageRefundRequest.findUnique({
          where: { id: request.id },
          select: { status: true },
        });
        throw refundInvalidTransition(current?.status ?? request.status, spec.action);
      }

      // The from-status of the audit row is the one the swap matched, re-read
      // under the row lock the update holds.
      await this.audit(tx, {
        requestId: request.id,
        action: spec.audit.action,
        fromStatus: request.status,
        toStatus: spec.audit.toStatus,
        actorKind: spec.audit.actorKind,
        actorId: spec.audit.actorId,
        note: spec.audit.note ?? null,
        now,
      });
      await touchTicket(tx, request.supportTicketId, now);
    });
    // After the commit: the intent is already durable, this only hurries it.
    this.notices.deliverSoon();
  }

  private async audit(
    tx: Tx,
    input: {
      requestId: string;
      action: PackageRefundAuditAction;
      fromStatus: PackageRefundRequestStatus | null;
      toStatus: PackageRefundRequestStatus;
      actorKind: PackageRefundActorKind;
      actorId: string;
      note?: string | null;
      now: Date;
    },
  ) {
    const event = await tx.packageRefundRequestEvent.create({
      data: {
        requestId: input.requestId,
        action: input.action,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorKind: input.actorKind,
        actorId: input.actorId,
        note: input.note ?? null,
        createdAt: input.now,
      },
      select: { id: true },
    });
    // The provider's notice for this transition, in the same transaction:
    // committed together or not at all. A withdrawal owes none.
    await enqueuePackageRefundNotice(tx, event.id);
    return event;
  }
}

/**
 * Moves a ticket's activity mark forwards, never backwards — the same rule the
 * support module's own writes follow.
 */
export async function touchTicket(tx: Tx, ticketId: string, now: Date) {
  await tx.supportTicket.updateMany({
    where: { id: ticketId, lastActivityAt: { lte: now } },
    data: { lastActivityAt: now },
  });
}

/** The ticket subject the server writes for a refund ticket; the provider does not type one. */
function refundTicketSubject(purchase: { packageNameSnapshot: string; purchaseNumber: string | null }) {
  const base = `Paket ve kredi iadesi: ${purchase.packageNameSnapshot}`;
  const withNumber = purchase.purchaseNumber ? `${base} (${purchase.purchaseNumber})` : base;
  return withNumber.length > SUPPORT_TICKET_SUBJECT_MAX_LENGTH
    ? withNumber.slice(0, SUPPORT_TICKET_SUBJECT_MAX_LENGTH)
    : withNumber;
}

/**
 * A second open request for one purchase loses on the partial unique index
 * when two submissions race past the pre-check; that is the same 409 the
 * pre-check gives.
 */
function mapOpenRequestViolation(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'P2002') {
    return refundAlreadyOpen();
  }
  return error;
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return PACKAGE_REFUND_PAGE_DEFAULT_SIZE;
  }
  return Math.min(Math.max(Math.trunc(value), 1), PACKAGE_REFUND_PAGE_MAX_SIZE);
}
