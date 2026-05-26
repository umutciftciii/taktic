import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreditTransactionType, OfferStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RefundOfferCreditDto } from './dto/refund-offer-credit.dto';

type OfferListFilters = {
  status?: string;
  providerId?: string;
  requestId?: string;
};

@Injectable()
export class OffersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listOffers(filters: OfferListFilters) {
    const status = normalizeOptionalOfferStatus(filters.status);
    const providerId = normalizeNullableString(filters.providerId);
    const requestId = normalizeNullableString(filters.requestId);

    return this.prisma.offer.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(providerId ? { providerId } : {}),
        ...(requestId ? { requestId } : {}),
      },
      orderBy: { submittedAt: 'desc' },
      include: offerInclude,
    });
  }

  async getOffer(id: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      include: offerInclude,
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    return offer;
  }

  async updateOfferStatus(id: string, status: OfferStatus) {
    const existingOffer = await this.ensureOfferExists(id);
    const now = new Date();

    return this.prisma.offer.update({
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
  }

  async refundOfferCredit(id: string, dto: RefundOfferCreditDto) {
    const reason = normalizeRequiredString(dto.reason, 'Refund reason');

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

        const currentBalance = await getProviderCreditBalanceInTransaction(tx, offer.providerId);
        const refundTransaction = await tx.providerCreditTransaction.create({
          data: {
            providerId: offer.providerId,
            type: CreditTransactionType.OFFER_REFUND,
            amount: offer.creditCost,
            balanceAfter: currentBalance + offer.creditCost,
            reason,
            referenceType: 'Offer',
            referenceId: offer.id,
          },
        });

        const updatedOffer = await tx.offer.update({
          where: { id: offer.id },
          data: {
            creditRefundedTransactionId: refundTransaction.id,
            creditRefundedAt: new Date(),
            creditRefundReason: reason,
          },
          include: offerInclude,
        });

        return {
          offer: updatedOffer,
          balance: refundTransaction.balanceAfter,
          refundTransaction,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listRequestOffers(requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

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
      submittedAt: offer.submittedAt,
    }));
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
