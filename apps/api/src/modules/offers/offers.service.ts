import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  OfferRejectionReason,
  OfferStatus,
  Prisma,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { CustomerOfferActionDto } from './dto/customer-offer-action.dto';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import { CUSTOMER_UNACTIONABLE_OFFER_STATUSES } from './offer-transitions';
import {
  calculateRefundEligibility,
  isManualRefundReasonCode,
  refundReasonLabel,
} from './refund-policy';

type OfferListFilters = {
  q?: string;
  status?: string;
  providerId?: string;
  requestId?: string;
  categoryId?: string;
  categorySlug?: string;
  city?: string;
  submittedFrom?: string;
  submittedTo?: string;
};

@Injectable()
export class OffersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listOffers(filters: OfferListFilters) {
    const status = normalizeOptionalOfferStatus(filters.status);
    const providerId = normalizeNullableString(filters.providerId);
    const requestId = normalizeNullableString(filters.requestId);
    const categoryId = normalizeNullableString(filters.categoryId);
    const categorySlug = normalizeNullableString(filters.categorySlug);
    const city = normalizeNullableString(filters.city);
    const submittedFrom = normalizeOptionalDate(filters.submittedFrom, 'submittedFrom');
    const submittedTo = normalizeOptionalDate(filters.submittedTo, 'submittedTo');
    const search = normalizeNullableString(filters.q);

    if (submittedFrom && submittedTo && submittedFrom > submittedTo) {
      throw new BadRequestException('submittedFrom cannot be after submittedTo');
    }

    const requestFilter: Prisma.ServiceRequestWhereInput = {};
    if (categoryId) {
      requestFilter.categoryId = categoryId;
    }
    if (categorySlug) {
      requestFilter.category = { slug: categorySlug };
    }
    if (city) {
      requestFilter.city = { contains: city, mode: 'insensitive' };
    }

    const where: Prisma.OfferWhereInput = {
      ...(status ? { status } : {}),
      ...(providerId ? { providerId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(submittedFrom || submittedTo
        ? {
            submittedAt: {
              ...(submittedFrom ? { gte: submittedFrom } : {}),
              ...(submittedTo ? { lte: submittedTo } : {}),
            },
          }
        : {}),
      ...(Object.keys(requestFilter).length > 0 ? { request: { is: requestFilter } } : {}),
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: 'insensitive' } },
              { requestId: { contains: search, mode: 'insensitive' } },
              { providerId: { contains: search, mode: 'insensitive' } },
              { provider: { is: { businessName: { contains: search, mode: 'insensitive' } } } },
              { provider: { is: { contactName: { contains: search, mode: 'insensitive' } } } },
              { provider: { is: { phone: { contains: search, mode: 'insensitive' } } } },
              { request: { is: { customerName: { contains: search, mode: 'insensitive' } } } },
              { request: { is: { customerPhone: { contains: search, mode: 'insensitive' } } } },
              { request: { is: { customerEmail: { contains: search, mode: 'insensitive' } } } },
              { request: { is: { city: { contains: search, mode: 'insensitive' } } } },
              { request: { is: { district: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const offers = await this.prisma.offer.findMany({
      where,
      orderBy: { submittedAt: 'desc' },
      include: offerInclude,
    });

    return offers.map(withRefundEligibility);
  }

  async getOffer(id: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      include: offerInclude,
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return withRefundEligibility(offer);
  }

  async updateOfferStatus(id: string, status: OfferStatus) {
    const existingOffer = await this.ensureOfferExists(id);
    const now = new Date();

    const updatedOffer = await this.prisma.offer.update({
      where: { id },
      data: {
        status,
        ...(status === OfferStatus.VIEWED && !existingOffer.viewedAt ? { viewedAt: now } : {}),
        ...(status === OfferStatus.ACCEPTED ? { acceptedAt: now } : {}),
        ...(status === OfferStatus.REJECTED ? { rejectedAt: now } : {}),
        ...(status === OfferStatus.WITHDRAWN ? { withdrawnAt: now } : {}),
      },
      include: offerInclude,
    });

    return withRefundEligibility(updatedOffer);
  }

  async refundOfferCredit(id: string, dto: RefundOfferCreditDto) {
    const reasonCode = normalizeRefundReasonCode(dto.reasonCode);
    const reasonNote = normalizeOptionalReason(dto.reason);

    return runSerializable(
      this.prisma,
      async (tx) => {
        const offer = await tx.offer.findUnique({
          where: { id },
          select: {
            id: true,
            providerId: true,
            creditCost: true,
            creditSpentTransactionId: true,
            creditRefundedTransactionId: true,
            creditRefundedAt: true,
            status: true,
            submittedAt: true,
            viewedAt: true,
            acceptedAt: true,
            // Needed so the policy can see a competitor-rejected offer and
            // recommend NO_REFUND; an admin can still refund it with override.
            rejectionReason: true,
          },
        });

        if (!offer) {
          throw new NotFoundException('Offer not found');
        }

        if (!offer.creditSpentTransactionId || offer.creditCost <= 0) {
          throw new BadRequestException('Offer has no credit spend to refund');
        }

        if (offer.creditRefundedTransactionId) {
          throw new ConflictException('Offer credit already refunded');
        }

        const refundEligibility = calculateRefundEligibility(offer);
        if (refundEligibility.recommendedAction === 'NO_REFUND' && dto.override !== true) {
          throw new BadRequestException('Refund is not recommended for this offer without override');
        }

        const storedReason =
          dto.override === true
            ? `${reasonCode}: ${reasonNote ?? 'Manual override'}`
            : `${reasonCode}: ${reasonNote ?? refundReasonLabel(reasonCode)}`;

        const { refundTransaction } = await refundOfferCreditInTransaction(tx, offer, storedReason);
        const updatedOffer = await tx.offer.findUnique({
          where: { id: offer.id },
          include: offerInclude,
        });

        if (!updatedOffer) {
          throw new NotFoundException('Offer not found');
        }

        return {
          offer: withRefundEligibility(updatedOffer),
          balance: refundTransaction.balanceAfter,
          refundTransaction,
        };
      },
      { label: 'offers.refundOfferCredit' },
    );
  }

  async listRequestOffers(requestId: string, user: AuthUser | null = null) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true, customerId: true },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    ensureCustomerCanAccessRequest(request.customerId, user);

    const offers = await this.prisma.offer.findMany({
      where: { requestId },
      orderBy: { submittedAt: 'desc' },
      include: {
        provider: {
          select: {
            businessName: true,
            city: true,
            district: true,
          },
        },
      },
    });

    return offers.map((offer) => ({
      id: offer.id,
      offerNumber: offer.offerNumber,
      provider: offer.provider,
      status: offer.status,
      priceAmount: offer.priceAmount,
      currency: offer.currency,
      estimatedStartDate: offer.estimatedStartDate,
      estimatedCompletionDate: offer.estimatedCompletionDate,
      message: offer.message,
      warrantyNote: offer.warrantyNote,
      creditCost: offer.creditCost,
      creditRefundedAt: offer.creditRefundedAt,
      creditRefundReason: offer.creditRefundReason,
      refundEligibility: calculateRefundEligibility(offer),
      submittedAt: offer.submittedAt,
    }));
  }

  async getRequestOffer(requestId: string, offerId: string, user: AuthUser | null = null) {
    const offer = await this.getRequestOfferOrThrow(requestId, offerId, user);
    return toCustomerOfferDetail(offer);
  }

  async markRequestOfferViewed(requestId: string, offerId: string, user: AuthUser | null = null) {
    const existingOffer = await this.getRequestOfferOrThrow(requestId, offerId, user);
    const now = new Date();

    const offer = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        ...(existingOffer.viewedAt ? {} : { viewedAt: now }),
        ...(existingOffer.status === OfferStatus.SUBMITTED ? { status: OfferStatus.VIEWED } : {}),
      },
      include: customerOfferInclude,
    });

    return toCustomerOfferDetail(offer);
  }

  async updateRequestOfferAction(
    requestId: string,
    offerId: string,
    dto: CustomerOfferActionDto,
    user: AuthUser | null = null,
  ) {
    const existingOffer = await this.getRequestOfferOrThrow(requestId, offerId, user);

    if (
      existingOffer.status === OfferStatus.WITHDRAWN ||
      existingOffer.status === OfferStatus.CANCELLED ||
      existingOffer.status === OfferStatus.EXPIRED
    ) {
      throw new BadRequestException('This offer cannot be acted on');
    }

    const status = customerActionToStatus(dto.action);

    if (status === OfferStatus.ACCEPTED) {
      return this.acceptRequestOffer(requestId, offerId, existingOffer.viewedAt);
    }

    const now = new Date();

    // Conditional, because the status read above is already stale by the time
    // this runs: the provider may have withdrawn the offer in between. The
    // clause repeats the guard rather than trusting the read, so a withdrawal
    // and a shortlist/reject cannot both land.
    const updated = await this.prisma.offer.updateMany({
      where: {
        id: offerId,
        status: { notIn: [...CUSTOMER_UNACTIONABLE_OFFER_STATUSES] },
      },
      data: {
        status,
        ...(existingOffer.viewedAt ? {} : { viewedAt: now }),
        // A hand-rejected offer deliberately gets no rejectionReason: NULL is
        // what keeps its existing refund behaviour.
        ...(status === OfferStatus.REJECTED ? { rejectedAt: now } : {}),
      },
    });

    if (updated.count !== 1) {
      throw new ConflictException('This offer can no longer be acted on');
    }

    const offer = await this.prisma.offer.findUniqueOrThrow({
      where: { id: offerId },
      include: customerOfferInclude,
    });

    return toCustomerOfferDetail(offer);
  }

  /**
   * Accepting an offer matches the request to it and closes every competing
   * offer, in one Serializable transaction.
   *
   * The request transition is the concurrency guard: only an APPROVED request
   * with no match yet can become MATCHED, so of two simultaneous accepts exactly
   * one updates a row and the other gets a 409. runSerializable retries the
   * write conflict Postgres raises for the loser, so the replay reaches that
   * business rule instead of leaking a 500. A partial unique index
   * (Offer_one_accepted_per_request) is the database-level backstop.
   */
  private acceptRequestOffer(requestId: string, offerId: string, viewedAt: Date | null) {
    const now = new Date();

    return runSerializable(
      this.prisma,
      async (tx) => {
        const matched = await tx.serviceRequest.updateMany({
          where: {
            id: requestId,
            status: ServiceRequestStatus.APPROVED,
            matchedOfferId: null,
          },
          data: {
            status: ServiceRequestStatus.MATCHED,
            matchedOfferId: offerId,
            matchedAt: now,
          },
        });

        if (matched.count !== 1) {
          throw new ConflictException('This request already has an accepted offer');
        }

        // Conditional for the same reason the request transition above is: a
        // provider may be withdrawing this very offer in a parallel Serializable
        // transaction. Only one of the two clauses can match, so the request can
        // never end up matched to an offer its provider had already pulled.
        const acceptedUpdate = await tx.offer.updateMany({
          where: {
            id: offerId,
            status: { notIn: [...CUSTOMER_UNACTIONABLE_OFFER_STATUSES] },
          },
          data: {
            status: OfferStatus.ACCEPTED,
            acceptedAt: now,
            ...(viewedAt ? {} : { viewedAt: now }),
          },
        });

        if (acceptedUpdate.count !== 1) {
          throw new ConflictException('This offer can no longer be accepted');
        }

        // Only offers still in play are closed. WITHDRAWN, CANCELLED, EXPIRED
        // and any already REJECTED offer are terminal and left untouched.
        await tx.offer.updateMany({
          where: {
            requestId,
            id: { not: offerId },
            status: {
              in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED],
            },
          },
          data: {
            status: OfferStatus.REJECTED,
            rejectedAt: now,
            rejectionReason: OfferRejectionReason.COMPETITOR_ACCEPTED,
          },
        });

        const accepted = await tx.offer.findUniqueOrThrow({
          where: { id: offerId },
          include: customerOfferInclude,
        });

        return toCustomerOfferDetail(accepted);
      },
      { label: 'offers.acceptRequestOffer' },
    );
  }

  private async ensureOfferExists(id: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      select: { id: true, viewedAt: true },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return offer;
  }

  private async getRequestOfferOrThrow(requestId: string, offerId: string, user: AuthUser | null = null) {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, requestId },
      include: customerOfferInclude,
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    ensureCustomerCanAccessRequest(offer.request.customerId, user);

    return offer;
  }
}

function ensureCustomerCanAccessRequest(customerId: string | null, user: AuthUser | null) {
  if (!customerId) {
    return;
  }

  if (!user) {
    throw new ForbiddenException('Customer-owned request requires authentication');
  }

  if (user.role === UserRole.SUPER_ADMIN) {
    return;
  }

  if (user.role !== UserRole.CUSTOMER || user.id !== customerId) {
    throw new ForbiddenException('Customer request access denied');
  }
}

function withRefundEligibility<T extends RefundPolicyOfferShape>(offer: T) {
  return {
    ...offer,
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

export async function refundOfferCreditInTransaction(
  tx: Prisma.TransactionClient,
  offer: {
    id: string;
    providerId: string;
    creditCost: number;
  },
  storedReason: string,
  options: { enforceAutomaticEligibility?: boolean } = {},
) {
  const currentBalance = await getProviderCreditBalanceInTransaction(tx, offer.providerId);
  const refundTransaction = await tx.providerCreditTransaction.create({
    data: {
      providerId: offer.providerId,
      type: CreditTransactionType.OFFER_REFUND,
      amount: offer.creditCost,
      balanceAfter: currentBalance + offer.creditCost,
      reason: storedReason,
      referenceType: 'Offer',
      referenceId: offer.id,
    },
  });

  const updated = await tx.offer.updateMany({
    where: {
      id: offer.id,
      creditRefundedTransactionId: null,
      creditRefundedAt: null,
      creditSpentTransactionId: { not: null },
      creditCost: { gt: 0 },
      ...(options.enforceAutomaticEligibility
        ? {
            viewedAt: null,
            status: {
              notIn: [
                OfferStatus.VIEWED,
                OfferStatus.ACCEPTED,
                OfferStatus.WITHDRAWN,
                OfferStatus.CANCELLED,
                OfferStatus.EXPIRED,
              ],
            },
          }
        : {}),
    },
    data: {
      creditRefundedTransactionId: refundTransaction.id,
      creditRefundedAt: new Date(),
      creditRefundReason: storedReason,
    },
  });

  if (updated.count !== 1) {
    throw new ConflictException('Offer credit is no longer eligible for refund');
  }

  return { refundTransaction };
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

const offerInclude = {
  provider: {
    select: {
      id: true,
      businessName: true,
      contactName: true,
      phone: true,
      email: true,
      city: true,
      district: true,
      status: true,
    },
  },
  request: {
    select: {
      id: true,
      requestNumber: true,
      city: true,
      district: true,
      neighborhood: true,
      status: true,
      qualityScore: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      category: {
        select: { id: true, name: true, slug: true },
      },
      customer: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
    },
  },
} satisfies Prisma.OfferInclude;

const customerOfferInclude = {
  provider: {
    select: {
      businessName: true,
      city: true,
      district: true,
    },
  },
  request: {
    select: {
      customerId: true,
    },
  },
} satisfies Prisma.OfferInclude;

function toCustomerOfferDetail(
  offer: Prisma.OfferGetPayload<{ include: typeof customerOfferInclude }>,
) {
  return {
    id: offer.id,
    requestId: offer.requestId,
    provider: offer.provider,
    status: offer.status,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    estimatedStartDate: offer.estimatedStartDate,
    estimatedCompletionDate: offer.estimatedCompletionDate,
    message: offer.message,
    warrantyNote: offer.warrantyNote,
    creditCost: offer.creditCost,
    creditRefundedAt: offer.creditRefundedAt,
    creditRefundReason: offer.creditRefundReason,
    refundEligibility: calculateRefundEligibility(offer),
    submittedAt: offer.submittedAt,
    viewedAt: offer.viewedAt,
    acceptedAt: offer.acceptedAt,
    rejectedAt: offer.rejectedAt,
  };
}

function customerActionToStatus(action: CustomerOfferActionDto['action']) {
  if (action === 'SHORTLIST') {
    return OfferStatus.SHORTLISTED;
  }

  if (action === 'REJECT') {
    return OfferStatus.REJECTED;
  }

  if (action === 'ACCEPT') {
    return OfferStatus.ACCEPTED;
  }

  throw new BadRequestException('Invalid offer action');
}

function normalizeOptionalOfferStatus(value: string | undefined) {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }

  if (!Object.values(OfferStatus).includes(normalized as OfferStatus)) {
    throw new BadRequestException('Invalid offer status filter');
  }

  return normalized as OfferStatus;
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

function normalizeOptionalReason(value: string | null | undefined) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException('Refund reason must be a string');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException('Refund reason cannot be empty when provided');
  }

  return trimmed;
}

function normalizeRefundReasonCode(value: unknown) {
  const reasonCode = normalizeRequiredString(value, 'Refund reason code');

  if (!isManualRefundReasonCode(reasonCode)) {
    throw new BadRequestException('Invalid refund reason code');
  }

  return reasonCode;
}

function normalizeOptionalDate(value: string | undefined | null, fieldName: string): Date | null {
  const normalized = normalizeNullableString(value ?? undefined);
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${fieldName} must be a valid ISO-8601 date`);
  }

  return date;
}
