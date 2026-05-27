import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditTransactionType, OfferStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { CustomerOfferActionDto } from './dto/customer-offer-action.dto';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';
import {
  calculateRefundEligibility,
  isManualRefundReasonCode,
  refundReasonLabel,
} from './refund-policy';

type OfferListFilters = {
  status?: string;
  providerId?: string;
  requestId?: string;
};

@Injectable()
export class OffersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listOffers(filters: OfferListFilters) {
    const status = normalizeOptionalOfferStatus(filters.status);
    const providerId = normalizeNullableString(filters.providerId);
    const requestId = normalizeNullableString(filters.requestId);

    const offers = await this.prisma.offer.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(providerId ? { providerId } : {}),
        ...(requestId ? { requestId } : {}),
      },
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

    return this.prisma.$transaction(
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

        const updatedOffer = await tx.offer.update({
          where: { id: offer.id },
          data: {
            creditRefundedTransactionId: refundTransaction.id,
            creditRefundedAt: new Date(),
            creditRefundReason: storedReason,
          },
          include: offerInclude,
        });

        return {
          offer: withRefundEligibility(updatedOffer),
          balance: refundTransaction.balanceAfter,
          refundTransaction,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
    const now = new Date();
    const offer = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        status,
        ...(existingOffer.viewedAt ? {} : { viewedAt: now }),
        ...(status === OfferStatus.ACCEPTED ? { acceptedAt: now } : {}),
        ...(status === OfferStatus.REJECTED ? { rejectedAt: now } : {}),
      },
      include: customerOfferInclude,
    });

    return toCustomerOfferDetail(offer);
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
      city: true,
      district: true,
      neighborhood: true,
      status: true,
      qualityScore: true,
      category: {
        select: { id: true, name: true, slug: true },
      },
    },
  },
};

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
