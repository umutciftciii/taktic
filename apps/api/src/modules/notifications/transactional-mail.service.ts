import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreditTransactionType,
  NotificationStatus,
  OfferStatus,
  ProviderStatus,
  ServiceRequestStatus,
} from '@prisma/client';
import {
  matchesProviderArea,
  phoneVerifiedRequestFilter,
} from '../../common/provider-request-matching';
import {
  customerAccountUrl,
  customerRequestUrl,
  providerAccountUrl,
  providerCreditsUrl,
  providerOfferUrl,
  providerProfileUrl,
  providerRequestUrl,
  providerRequestsUrl,
} from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { readContactSharingConfig } from '../contact-sharing/contact-sharing.config';
import { refundReasonLabel } from '../offers/refund-policy';
import {
  DedupedDispatchContext,
  DispatchContext,
  NotificationDispatcher,
} from './notification-dispatcher.service';
import {
  TransactionalEmailTemplate,
  transactionalSubject,
} from './templates/transactional-templates';

/**
 * Sends the twelve designed transactional messages.
 *
 * One service rather than a send scattered through the domain modules, because
 * all twelve share the same three properties and each of them is easy to get
 * wrong one call site at a time:
 *
 * 1. **Never inside the business transaction.** Every method here is called
 *    after the transaction that caused the event has committed, and every one
 *    of them swallows its own failures. A broken mail transport must not roll
 *    back an accepted offer or a submitted request. This mirrors what the guest
 *    activation link and the provider claim invitation already do.
 *
 * 2. **Once per real state transition.** Each send carries a `dedupeKey` built
 *    from the ids (and, where a transition can legitimately recur, the
 *    timestamp) of the thing that happened. The unique index on
 *    (template, dedupeKey) is what makes that a guarantee: a retried request, a
 *    second API instance, or an admin who clicks twice all collide and send
 *    nothing. A failed send is not retried — see NotificationDispatcher.
 *
 * 3. **A snapshot, not a live read.** The values are read once, here, and
 *    handed to the renderer as strings. A profile edited after the fact cannot
 *    change what an already-sent message said, and nothing in the template
 *    re-queries the database.
 *
 * What is *not* here is as deliberate. No method loads a field the recipient is
 * not already entitled to see on their own screens, and the two that carry
 * contact details read the same ContactRevealEvent the contact-sharing
 * endpoints read — so a message can never become a quieter second route to a
 * phone number.
 */
@Injectable()
export class TransactionalMailService {
  private readonly logger = new Logger(TransactionalMailService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
  ) {}

  // ─────────────────────────── 01 · password reset ───────────────────────────

  /**
   * The caller owns the token, so it hands over the URL rather than letting this
   * service reach for one: the raw token exists in memory for exactly as long as
   * the issuing transaction needs it, and it is stored nowhere.
   *
   * No `dedupeKey`. Asking for a second reset link is a legitimate thing to do
   * and must produce a second link; the rate limit, not the audit table, is what
   * bounds it.
   */
  sendPasswordReset(input: {
    userId: string;
    email: string;
    fullName: string | null;
    resetUrl: string;
    requestedAt: Date;
    expiryMinutes: number;
  }) {
    return this.send(
      'password-reset',
      input.email,
      {
        fullName: input.fullName,
        requestedAt: input.requestedAt.toISOString(),
        expiryMinutes: String(input.expiryMinutes),
      },
      { userId: input.userId },
      input.resetUrl,
    );
  }

  // ───────────────────────── 02 · e-mail verification ────────────────────────

  /** Same reasoning as the reset link, including the absence of a dedupe key. */
  sendEmailVerification(input: {
    userId: string;
    email: string;
    fullName: string | null;
    verifyUrl: string;
    expiryDays: number;
  }) {
    return this.send(
      'email-verification',
      input.email,
      {
        fullName: input.fullName,
        expiryDays: String(input.expiryDays),
      },
      { userId: input.userId },
      input.verifyUrl,
    );
  }

  // ──────────────────── 03 · provider.application_submitted ──────────────────

  async sendProviderApplicationReceived(providerId: string) {
    const provider = await this.loadProvider(providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'provider-application-received',
      provider.recipient,
      {
        fullName: provider.contactName,
        businessName: provider.businessName,
        categories: provider.categories,
        areas: provider.areas,
        statusLabel: providerStatusLabel(provider.status),
        // Only for an application that already belongs to an account. A guest
        // application is reached through the claim link, not by editing.
        profileUrl: provider.userId ? providerProfileUrl(provider.id) : null,
      },
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `application-received:${provider.id}`,
      },
    );
  }

  // ──────────────────── 04 · provider.application_approved ───────────────────

  /**
   * `approvedAt` is part of the key on purpose. A provider suspended and later
   * re-approved has genuinely been approved twice and should hear about it
   * twice; the same approval replayed carries the same timestamp and does not.
   */
  async sendProviderApplicationApproved(providerId: string, approvedAt: Date) {
    const provider = await this.loadProvider(providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'provider-application-approved',
      provider.recipient,
      {
        fullName: provider.contactName,
        businessName: provider.businessName,
        categories: provider.categories,
        areas: provider.areas,
        requestsUrl: providerRequestsUrl(provider.id),
        accountUrl: providerAccountUrl(),
      },
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `application-approved:${provider.id}:${approvedAt.toISOString()}`,
      },
    );
  }

  // ────────────────────────────── 05 · request.created ───────────────────────

  async sendRequestReceived(requestId: string) {
    const request = await this.loadRequest(requestId);
    if (!request?.customerEmail) {
      return;
    }

    await this.send(
      'request-received',
      request.customerEmail,
      {
        fullName: request.customerName,
        requestNumber: request.requestNumber,
        categoryName: request.category.name,
        city: request.city,
        district: request.district,
        preferredDate: request.preferredDate?.toISOString() ?? null,
        urgency: request.urgency,
        statusLabel: requestStatusLabel(request.status),
        requestUrl: customerRequestUrl(request.id),
        accountUrl: customerAccountUrl(),
      },
      {
        requestId: request.id,
        userId: request.customerId,
        dedupeKey: `request-received:${request.id}`,
      },
    );
  }

  // ───────────── 06 + 09 · request.approved → customer, then providers ───────

  /**
   * The approval fan-out, both halves.
   *
   * The audience is resolved first, because the customer's own message reports
   * how many providers the request reached and that number has to be the real
   * one — the same list the invitations then go to, matched by the same rules
   * the discovery screen uses.
   *
   * The invitations are sent one at a time, outside any transaction, each with
   * its own dedupe key. That is what makes the whole operation safe to re-run:
   * a crash halfway through leaves the providers already mailed claimed, and a
   * second run reaches only the rest. It is also why there is no batching — a
   * thousand recipients is a thousand independent sends, not one long
   * transaction holding locks while a mail provider answers.
   */
  async fanOutApprovedRequest(requestId: string, approvedAt: Date) {
    const request = await this.loadRequest(requestId);
    if (!request || request.status !== ServiceRequestStatus.APPROVED) {
      return { reached: 0, notified: 0 };
    }

    const audience = await this.findMatchingProviders(request);

    if (request.customerEmail) {
      await this.send(
        'request-published',
        request.customerEmail,
        {
          fullName: request.customerName,
          requestNumber: request.requestNumber,
          categoryName: request.category.name,
          district: request.district,
          reachedProviderCount: String(audience.length),
          requestUrl: customerRequestUrl(request.id),
          accountUrl: customerAccountUrl(),
        },
        {
          requestId: request.id,
          userId: request.customerId,
          dedupeKey: `request-published:${request.id}:${approvedAt.toISOString()}`,
        },
      );
    }

    let notified = 0;

    for (const provider of audience) {
      if (!provider.recipient) {
        continue;
      }

      const outcome = await this.send(
        'request-available',
        provider.recipient,
        {
          fullName: provider.contactName,
          requestNumber: request.requestNumber,
          categoryName: request.category.name,
          // City and district only. The neighbourhood, the address note and
          // every customer contact field stay out of a message that reaches
          // everybody who matched.
          city: request.city,
          district: request.district,
          qualityScore: String(request.qualityScore),
          creditCost:
            request.category.offerCreditCost === null
              ? null
              : String(request.category.offerCreditCost),
          creditBalance: String(await this.creditBalance(provider.id)),
          requestUrl: providerRequestUrl(provider.id, request.id),
          accountUrl: providerAccountUrl(),
        },
        {
          requestId: request.id,
          providerId: provider.id,
          userId: provider.userId,
          dedupeKey: `request-available:${request.id}:${provider.id}`,
        },
      );

      if (outcome?.status === NotificationStatus.SENT) {
        notified += 1;
      }
    }

    // Counts only, and always — an operator reading this can tell a fan-out
    // that reached nobody from one whose transport was down, without either
    // being inferred from silence. Nothing is capped, so `reached` is the whole
    // audience rather than a page of it.
    this.logger.log(
      `request-available fan-out for ${request.id}: reached=${audience.length} notified=${notified}`,
    );

    return { reached: audience.length, notified };
  }

  // ─────────────────────────────── 07 · offer.created ────────────────────────

  async sendOfferReceived(offerId: string) {
    const offer = await this.loadOffer(offerId);
    if (!offer?.request.customerEmail) {
      return;
    }

    // The customer's own count of offers they can still act on — the same
    // number their panel shows, which excludes withdrawn ones.
    const openOfferCount = await this.prisma.offer.count({
      where: { requestId: offer.requestId, status: { not: OfferStatus.WITHDRAWN } },
    });

    await this.send(
      'offer-received',
      offer.request.customerEmail,
      {
        fullName: offer.request.customerName,
        requestNumber: offer.request.requestNumber,
        // The public profile field, and only that. There is no rating system to
        // report and nothing here reveals the provider's contact details.
        providerName: offer.provider.businessName,
        offerAmountMinor: String(offer.priceAmount),
        availability: offer.estimatedStartDate?.toISOString() ?? null,
        offerNote: offer.message,
        openOfferCount: String(openOfferCount),
        offersUrl: customerRequestUrl(offer.requestId),
        accountUrl: customerAccountUrl(),
      },
      {
        requestId: offer.requestId,
        userId: offer.request.customerId,
        dedupeKey: `offer-received:${offer.id}`,
      },
    );
  }

  // ──────────────── 08 + 10 · offer.accepted → both sides of the match ───────

  /**
   * The two messages one acceptance produces.
   *
   * Contact details appear in either of them only when the accept transaction
   * really opened them: the flag on, the request's disclosure acceptance
   * current, and the ContactRevealEvent written and agreeing with
   * `matchedOfferId`. That is the same set of conditions the contact endpoints
   * check, read from the same row — with any of them missing the fields are
   * simply not passed and the rows disappear from the design.
   */
  async sendMatchNotifications(offerId: string) {
    const offer = await this.loadOffer(offerId);
    if (!offer || offer.status !== OfferStatus.ACCEPTED) {
      return;
    }

    const disclosed = await this.contactDisclosureFor(offer.requestId, offer.id, offer.providerId);

    if (offer.request.customerEmail) {
      await this.send(
        'match-customer',
        offer.request.customerEmail,
        {
          fullName: offer.request.customerName,
          businessName: offer.provider.businessName,
          contactName: disclosed ? offer.provider.contactName : null,
          contactPhone: disclosed ? offer.provider.phone : null,
          acceptedAmountMinor: String(offer.priceAmount),
          requestNumber: offer.request.requestNumber,
          categoryName: offer.request.category.name,
          requestUrl: customerRequestUrl(offer.requestId),
          accountUrl: customerAccountUrl(),
        },
        {
          requestId: offer.requestId,
          userId: offer.request.customerId,
          providerId: offer.providerId,
          dedupeKey: `match-customer:${offer.id}`,
        },
      );
    }

    const providerRecipient = recipientFor(offer.provider);
    if (providerRecipient) {
      await this.send(
        'offer-accepted',
        providerRecipient,
        {
          fullName: offer.provider.contactName,
          customerName: disclosed ? offer.request.customerName : null,
          customerPhone: disclosed ? offer.request.customerPhone : null,
          // District and city — what the offer was quoted for. The
          // neighbourhood and the address note are not part of the brief the
          // winning provider receives, on screen or here.
          city: offer.request.city,
          district: offer.request.district,
          acceptedAmountMinor: String(offer.priceAmount),
          preferredDate: offer.request.preferredDate?.toISOString() ?? null,
          urgency: offer.request.urgency,
          requestNumber: offer.request.requestNumber,
          offerUrl: providerOfferUrl(offer.providerId, offer.id),
          accountUrl: providerAccountUrl(),
        },
        {
          requestId: offer.requestId,
          providerId: offer.providerId,
          userId: offer.provider.userId,
          dedupeKey: `offer-accepted:${offer.id}`,
        },
      );
    }
  }

  // ───────────────── 11 · offer.rejected → the providers not chosen ──────────

  /**
   * Sent for an offer that was really rejected — by hand or by the accept
   * cascade — and for nothing else.
   *
   * The status is re-read here rather than trusted from the caller, because the
   * one mistake this message must not make is telling a provider who withdrew
   * their own offer that they "were not selected". A WITHDRAWN, CANCELLED or
   * EXPIRED offer produces nothing.
   */
  async sendOfferNotSelected(offerIds: readonly string[]) {
    for (const offerId of offerIds) {
      const offer = await this.loadOffer(offerId);
      if (!offer || offer.status !== OfferStatus.REJECTED) {
        continue;
      }

      const recipient = recipientFor(offer.provider);
      if (!recipient) {
        continue;
      }

      await this.send(
        'offer-not-selected',
        recipient,
        {
          fullName: offer.provider.contactName,
          requestNumber: offer.request.requestNumber,
          categoryName: offer.request.category.name,
          offerAmountMinor: String(offer.priceAmount),
          requestsUrl: providerRequestsUrl(offer.providerId),
          accountUrl: providerAccountUrl(),
        },
        {
          requestId: offer.requestId,
          providerId: offer.providerId,
          userId: offer.provider.userId,
          dedupeKey: `offer-not-selected:${offer.id}`,
        },
      );
    }
  }

  // ────────────────────────────── 12 · credit.refunded ───────────────────────

  /**
   * Every figure comes from the ledger row the refund wrote: the amount, the
   * balance it produced, and the balance before it. Nothing is recomputed from
   * a live balance, so a purchase that lands a second later cannot rewrite what
   * this message said the refund did.
   */
  async sendCreditRefunded(refundTransactionId: string) {
    const transaction = await this.prisma.providerCreditTransaction.findUnique({
      where: { id: refundTransactionId },
      select: {
        id: true,
        type: true,
        amount: true,
        balanceAfter: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        providerId: true,
      },
    });

    if (!transaction || transaction.type !== CreditTransactionType.OFFER_REFUND) {
      return;
    }

    const provider = await this.loadProvider(transaction.providerId);
    if (!provider?.recipient) {
      return;
    }

    const offer =
      transaction.referenceType === 'Offer' && transaction.referenceId
        ? await this.loadOffer(transaction.referenceId)
        : null;

    await this.send(
      'credit-refunded',
      provider.recipient,
      {
        fullName: provider.contactName,
        requestNumber: offer?.request.requestNumber ?? null,
        categoryName: offer?.request.category.name ?? null,
        refundReason: knownRefundReasonLabel(transaction.reason),
        refundedCredits: String(transaction.amount),
        previousBalance: String(transaction.balanceAfter - transaction.amount),
        currentBalance: String(transaction.balanceAfter),
        creditsUrl: providerCreditsUrl(provider.id),
        accountUrl: providerAccountUrl(),
      },
      {
        providerId: provider.id,
        userId: provider.userId,
        requestId: offer?.requestId ?? null,
        dedupeKey: `credit-refunded:${transaction.id}`,
      },
    );
  }

  // ──────────────────────────────── plumbing ─────────────────────────────────

  /**
   * The single send path.
   *
   * It never throws. Every caller is already past its own commit point, so the
   * only thing a raised error could achieve is turning a delivered outcome into
   * a failed HTTP response.
   */
  private async send(
    template: TransactionalEmailTemplate,
    to: string,
    data: Record<string, string | null | undefined>,
    context: DispatchContext | DedupedDispatchContext,
    actionUrl?: string,
  ) {
    const message = {
      template,
      to,
      subject: transactionalSubject(template, data),
      actionUrl,
      data,
    };

    try {
      return 'dedupeKey' in context
        ? await this.dispatcher.sendEmailOnce(message, context)
        : await this.dispatcher.sendEmail(message, context);
    } catch (error) {
      // Nothing about the message: not the address, not the subject, not the
      // body. The template name and the failure's own stack are all an operator
      // needs to find this, and NotificationLog carries the rest.
      this.logger.error(
        `Failed to compose ${template}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /**
   * The providers a newly approved request reaches.
   *
   * Same predicates as the discovery list, in the same order: approved
   * providers only, the request's own category, the phone-verification gate,
   * and then the service-area match applied in memory by the shared matcher.
   * Nothing widens it — a provider who could not find this request on their own
   * screen does not receive a mail about it.
   */
  private async findMatchingProviders(request: {
    id: string;
    categoryId: string;
    city: string;
    district: string;
    neighborhood: string | null;
  }) {
    // Re-reads the request through the same gate the discovery query applies,
    // so a deployment that requires phone verification does not fan out an
    // unverified request.
    const visible = await this.prisma.serviceRequest.count({
      where: {
        id: request.id,
        status: ServiceRequestStatus.APPROVED,
        ...phoneVerifiedRequestFilter(),
      },
    });

    if (visible === 0) {
      return [];
    }

    const providers = await this.prisma.providerProfile.findMany({
      where: {
        status: ProviderStatus.APPROVED,
        serviceCategories: { some: { categoryId: request.categoryId } },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        userId: true,
        contactName: true,
        email: true,
        user: { select: { email: true } },
        serviceAreas: { select: { city: true, district: true, neighborhood: true } },
      },
    });

    return providers
      .filter((provider) => matchesProviderArea(provider.serviceAreas, request))
      .map((provider) => ({
        id: provider.id,
        userId: provider.userId,
        contactName: provider.contactName,
        recipient: recipientFor(provider),
      }));
  }

  /**
   * Whether this match really opened contact details.
   *
   * The audit row is the authority, exactly as it is for the contact endpoints:
   * the feature must be on, the request must be MATCHED to this offer, and the
   * reveal must name this offer and this provider. Anything else is false, and
   * the message goes out without the contact rows.
   */
  private async contactDisclosureFor(
    requestId: string,
    offerId: string,
    providerId: string,
  ): Promise<boolean> {
    if (!readContactSharingConfig().enabled) {
      return false;
    }

    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { status: true, matchedOfferId: true },
    });

    if (request?.status !== ServiceRequestStatus.MATCHED || request.matchedOfferId !== offerId) {
      return false;
    }

    const reveal = await this.prisma.contactRevealEvent.findUnique({
      where: { requestId },
      select: { offerId: true, providerId: true },
    });

    return reveal?.offerId === offerId && reveal.providerId === providerId;
  }

  private async creditBalance(providerId: string): Promise<number> {
    const latest = await this.prisma.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true },
    });

    return latest?.balanceAfter ?? 0;
  }

  private async loadProvider(providerId: string) {
    const provider = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        userId: true,
        businessName: true,
        contactName: true,
        email: true,
        status: true,
        user: { select: { email: true } },
        serviceCategories: {
          orderBy: { createdAt: 'asc' },
          select: { category: { select: { name: true } } },
        },
        serviceAreas: {
          orderBy: [{ city: 'asc' }, { district: 'asc' }],
          select: { city: true, district: true },
        },
      },
    });

    if (!provider) {
      return null;
    }

    return {
      ...provider,
      recipient: recipientFor(provider),
      categories: joinDistinct(
        provider.serviceCategories.map((entry) => entry.category.name),
      ),
      // The provider's own service areas, so nothing here is a disclosure. A
      // row with no district covers its whole city and is shown as the city.
      areas: joinDistinct(provider.serviceAreas.map((area) => area.district ?? area.city)),
    };
  }

  private loadRequest(requestId: string) {
    return this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        requestNumber: true,
        status: true,
        categoryId: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        city: true,
        district: true,
        neighborhood: true,
        preferredDate: true,
        urgency: true,
        qualityScore: true,
        category: { select: { name: true, offerCreditCost: true } },
      },
    });
  }

  private loadOffer(offerId: string) {
    return this.prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        requestId: true,
        providerId: true,
        status: true,
        priceAmount: true,
        message: true,
        estimatedStartDate: true,
        provider: {
          select: {
            id: true,
            userId: true,
            businessName: true,
            contactName: true,
            phone: true,
            email: true,
            user: { select: { email: true } },
          },
        },
        request: {
          select: {
            requestNumber: true,
            customerId: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            city: true,
            district: true,
            preferredDate: true,
            urgency: true,
            category: { select: { name: true } },
          },
        },
      },
    });
  }
}

/**
 * Where a provider's mail goes: the application's own contact address, falling
 * back to the owning account's.
 *
 * The application address leads because it is the one the applicant typed and
 * the one the claim flow pins to the owner's address once ownership is granted
 * — so for a claimed profile the two are the same value anyway.
 */
function recipientFor(provider: {
  email: string | null;
  user?: { email: string | null } | null;
}): string | null {
  const candidate = provider.email?.trim() || provider.user?.email?.trim();
  return candidate ? candidate : null;
}

/**
 * The stored refund reason is `"<CODE>: <free text>"`, and the free text can be
 * an admin's internal note. Only the code is read, and only when it is one this
 * build knows — anything else yields null and the row disappears, rather than
 * putting an internal note in a provider's inbox.
 */
function knownRefundReasonLabel(stored: string | null): string | null {
  const code = stored?.split(':', 1)[0]?.trim();
  if (!code) {
    return null;
  }

  const label = refundReasonLabel(code);
  // refundReasonLabel echoes an unrecognised code back unchanged, which is
  // exactly the case that must not be shown.
  return label === code ? null : label;
}

function joinDistinct(values: readonly string[]): string | null {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join(', ') : null;
}

const REQUEST_STATUS_LABELS: Partial<Record<ServiceRequestStatus, string>> = {
  [ServiceRequestStatus.SUBMITTED]: 'İnceleniyor',
  [ServiceRequestStatus.IN_REVIEW]: 'İnceleniyor',
  [ServiceRequestStatus.APPROVED]: 'Yayında',
  [ServiceRequestStatus.MATCHED]: 'Eşleşti',
  [ServiceRequestStatus.COMPLETED]: 'Tamamlandı',
};

function requestStatusLabel(status: ServiceRequestStatus): string | null {
  return REQUEST_STATUS_LABELS[status] ?? null;
}

const PROVIDER_STATUS_LABELS: Partial<Record<ProviderStatus, string>> = {
  [ProviderStatus.PENDING_REVIEW]: 'İnceleniyor',
  [ProviderStatus.APPROVED]: 'Onaylandı',
};

function providerStatusLabel(status: ProviderStatus): string | null {
  return PROVIDER_STATUS_LABELS[status] ?? null;
}
