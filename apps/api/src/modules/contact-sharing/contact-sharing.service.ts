import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServiceRequestStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  readContactSharingConfig,
  requireContactSharingEnabled,
  type EnabledContactSharingConfig,
} from './contact-sharing.config';

/**
 * The only place contact details cross from one party to the other.
 *
 * Nothing here widens an existing projection: the offer list, the offer detail
 * and the provider's matching list stay exactly as narrow as they were, and a
 * caller that wants a phone number has to come through one of these methods and
 * satisfy every one of their conditions.
 *
 * Four conditions gate every read, and all four must hold:
 *   1. the feature is on;
 *   2. the request is MATCHED;
 *   3. the request's matchedOfferId and its ContactRevealEvent agree;
 *   4. the caller is one of the two parties that event names.
 */

/** Everything the customer may learn about the provider they chose. */
const providerContactSelect = {
  id: true,
  businessName: true,
  contactName: true,
  phone: true,
  email: true,
  city: true,
  district: true,
} satisfies Prisma.ProviderProfileSelect;

/**
 * Everything the provider may learn about the customer who chose them: the
 * three fields the customer typed into the request, and nothing from the linked
 * User account.
 */
const customerContactSelect = {
  customerName: true,
  customerPhone: true,
  customerEmail: true,
} satisfies Prisma.ServiceRequestSelect;

const revealSelect = {
  id: true,
  requestId: true,
  offerId: true,
  customerUserId: true,
  providerId: true,
  revealedAt: true,
  disclosureVersion: true,
} satisfies Prisma.ContactRevealEventSelect;

type RevealRow = Prisma.ContactRevealEventGetPayload<{ select: typeof revealSelect }>;

@Injectable()
export class ContactSharingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Public configuration for the request form. Carries no personal data. */
  getDisclosure() {
    const config = readContactSharingConfig();

    return config.enabled
      ? {
          enabled: true,
          disclosureUrl: config.disclosureUrl,
          disclosureVersion: config.disclosureVersion,
        }
      : { enabled: false, disclosureUrl: null, disclosureVersion: null };
  }

  /** The chosen provider's details, for the customer who chose them. */
  async getProviderContactForCustomer(requestId: string, user: AuthUser) {
    const config = requireContactSharingEnabled();
    const { request, reveal } = await this.loadRevealed(requestId, config);

    if (user.role !== UserRole.CUSTOMER || !request.customerId || request.customerId !== user.id) {
      throw new ForbiddenException('Matched contact access denied');
    }

    const provider = await this.prisma.providerProfile.findUniqueOrThrow({
      where: { id: reveal.providerId },
      select: providerContactSelect,
    });

    return { ...toRevealSummary(reveal), provider };
  }

  /** The customer's details, for the provider whose offer was accepted. */
  async getCustomerContactForProvider(providerId: string, offerId: string) {
    const config = requireContactSharingEnabled();

    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, providerId },
      select: { id: true, requestId: true },
    });

    // A losing provider asking about its own offer, and a provider asking about
    // an offer it does not own, are the same answer: this offer has nothing to
    // show. The next check is what distinguishes "not yours" from "not matched".
    if (!offer) {
      throw new NotFoundException('Matched contact not found');
    }

    const { request, reveal } = await this.loadRevealed(offer.requestId, config);

    if (reveal.offerId !== offerId || reveal.providerId !== providerId) {
      throw new NotFoundException('Matched contact not found');
    }

    return {
      ...toRevealSummary(reveal),
      customer: {
        customerName: request.customerName,
        customerPhone: request.customerPhone,
        customerEmail: request.customerEmail,
      },
    };
  }

  /**
   * The admin view: the audit row always, the details only when the feature is
   * on and a reveal actually happened.
   *
   * The audit metadata is deliberately not gated on the flag — it names no
   * person and it is what an operator needs to answer "why were these details
   * opened?" long after the fact.
   */
  async getContactRevealForAdmin(requestId: string) {
    const config = readContactSharingConfig();

    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        matchedOfferId: true,
        customerId: true,
        ...customerContactSelect,
      },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    const reveal = await this.prisma.contactRevealEvent.findUnique({
      where: { requestId },
      select: revealSelect,
    });

    const consistent = Boolean(
      reveal && request.status === ServiceRequestStatus.MATCHED && request.matchedOfferId === reveal.offerId,
    );

    if (!config.enabled || !reveal || !consistent) {
      return {
        enabled: config.enabled,
        event: reveal ? toRevealSummary(reveal) : null,
        contacts: null,
      };
    }

    const provider = await this.prisma.providerProfile.findUniqueOrThrow({
      where: { id: reveal.providerId },
      select: providerContactSelect,
    });

    return {
      enabled: true,
      event: toRevealSummary(reveal),
      contacts: {
        provider,
        customer: {
          customerName: request.customerName,
          customerPhone: request.customerPhone,
          customerEmail: request.customerEmail,
        },
      },
    };
  }

  /**
   * Loads a request that really is matched and really has a consistent audit
   * row. Every failure is the same 404: whether the request does not exist, is
   * not matched, or was matched to a different offer is not something a caller
   * gets to distinguish.
   */
  private async loadRevealed(requestId: string, config: EnabledContactSharingConfig) {
    void config;

    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        matchedOfferId: true,
        customerId: true,
        ...customerContactSelect,
      },
    });

    if (!request || request.status !== ServiceRequestStatus.MATCHED || !request.matchedOfferId) {
      throw new NotFoundException('Matched contact not found');
    }

    const reveal = await this.prisma.contactRevealEvent.findUnique({
      where: { requestId },
      select: revealSelect,
    });

    // The audit row is the authority. A match without one — or one that names a
    // different offer — discloses nothing, however the request looks.
    if (!reveal || reveal.offerId !== request.matchedOfferId) {
      throw new NotFoundException('Matched contact not found');
    }

    return { request, reveal };
  }
}

function toRevealSummary(reveal: RevealRow) {
  return {
    requestId: reveal.requestId,
    offerId: reveal.offerId,
    providerId: reveal.providerId,
    customerUserId: reveal.customerUserId,
    revealedAt: reveal.revealedAt,
    disclosureVersion: reveal.disclosureVersion,
  };
}
