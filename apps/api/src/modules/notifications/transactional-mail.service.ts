import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreditTransactionType,
  NotificationStatus,
  OfferPackageType,
  OfferStatus,
  PackagePurchaseKind,
  PackagePurchaseStatus,
  Prisma,
  ProviderStatus,
  ServiceCategoryStatus,
  ServiceRequestStatus,
  ShowcaseLeadStatus,
  ShowcaseLeadUrgency,
  ShowcasePlacementStatus,
  ShowcaseVersionReview,
  SupportTicketAuthorRole,
  SupportTicketRequesterRole,
} from '@prisma/client';
import {
  matchesProviderArea,
  phoneVerifiedRequestFilter,
} from '../../common/provider-request-matching';
import { describeArea } from '../../common/provider-service-area-scope';
import {
  adminSupportTicketUrl,
  customerAccountUrl,
  customerNewRequestUrl,
  customerRequestUrl,
  customerShowcaseDecisionUrl,
  customerSupportTicketUrl,
  providerAccountUrl,
  providerCreditsUrl,
  providerOfferUrl,
  providerProfileUrl,
  providerRequestUrl,
  providerRequestsUrl,
  providerShowcaseCardUrl,
  providerShowcaseLeadUrl,
  providerShowcaseNewCardUrl,
  providerShowcasePackagesUrl,
  providerShowcaseUrl,
} from '../../common/web-routes';
import { PrismaService } from '../../prisma/prisma.service';
import { readContactSharingConfig } from '../contact-sharing/contact-sharing.config';
import {
  DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  refundReasonLabel,
} from '../offers/refund-policy';
import { REQUEST_EXPIRY_DAYS } from '../request-lifecycle/request-lifecycle.constants';
import {
  readSupportInboxEmail,
  supportReplyToEmail,
} from '../support-tickets/support-inbox.config';
import {
  DedupedDispatchContext,
  DispatchContext,
  NotificationDispatcher,
} from './notification-dispatcher.service';
import { NotificationMessage } from './notification.port';
import {
  TransactionalEmailTemplate,
  transactionalSubject,
} from './templates/transactional-templates';

/**
 * Sends the transactional messages that follow a domain event.
 *
 * One service rather than a send scattered through the domain modules, because
 * every one of them shares the same three properties and each is easy to get
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
      { actionUrl: input.resetUrl },
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
      { actionUrl: input.verifyUrl },
    );
  }

  // ──────────────────── 03 · provider.application_submitted ──────────────────

  async sendProviderApplicationReceived(providerId: string) {
    const provider = await loadProvider(this.prisma, providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'provider-application-received',
      provider.recipient,
      providerApplicationReceivedData(provider),
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
    const provider = await loadProvider(this.prisma, providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'provider-application-approved',
      provider.recipient,
      providerApplicationApprovedData(provider),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `application-approved:${provider.id}:${approvedAt.toISOString()}`,
      },
    );
  }

  // ────────────────────────────── 05 · request.created ───────────────────────

  /**
   * `nextStep` is what the request is waiting for once the receipt is read:
   * an operator's review (the default, and what every receipt said before
   * auto-publish existed) or the customer's own telephone verification, after
   * which the request goes live with nobody in between.
   */
  async sendRequestReceived(
    requestId: string,
    options: { nextStep: RequestReceivedNextStep } = { nextStep: 'review' },
  ) {
    const request = await loadRequest(this.prisma, requestId);
    if (!request?.customerEmail) {
      return;
    }

    await this.send(
      'request-received',
      request.customerEmail,
      { ...requestReceivedData(request), nextStep: options.nextStep },
      {
        requestId: request.id,
        userId: request.customerId,
        dedupeKey: `request-received:${request.id}`,
      },
    );
  }

  // ───────────── 06 + 09 · request.approved → customer, then providers ───────
  //
  // The approval fan-out is no longer sent from here. It is booked as intents
  // by `RequestPublishOutbox.enqueue` inside the transaction that publishes
  // the request, and each intent is rebuilt by `composeRetryMessage` below
  // (`request-published`, `request-available`) when the outbox delivers it.

  // ─────────────────────────────── 07 · offer.created ────────────────────────

  async sendOfferReceived(offerId: string) {
    const offer = await loadOffer(this.prisma, offerId);
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
      offerReceivedData(offer, openOfferCount),
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
    const offer = await loadOffer(this.prisma, offerId);
    if (!offer || offer.status !== OfferStatus.ACCEPTED) {
      return;
    }

    const disclosed = await contactDisclosureFor(this.prisma, offer.requestId, offer.id, offer.providerId);

    if (offer.request.customerEmail) {
      await this.send(
        'match-customer',
        offer.request.customerEmail,
        matchCustomerData(offer, disclosed),
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
        offerAcceptedData(offer, disclosed),
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
      const offer = await loadOffer(this.prisma, offerId);
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
        offerNotSelectedData(offer),
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

    const provider = await loadProvider(this.prisma, transaction.providerId);
    if (!provider?.recipient) {
      return;
    }

    const offer =
      transaction.referenceType === 'Offer' && transaction.referenceId
        ? await loadOffer(this.prisma, transaction.referenceId)
        : null;

    await this.send(
      'credit-refunded',
      provider.recipient,
      creditRefundedData(provider, offer, transaction),
      {
        providerId: provider.id,
        userId: provider.userId,
        requestId: offer?.requestId ?? null,
        dedupeKey: `credit-refunded:${transaction.id}`,
      },
    );
  }

  // ────────────────── 16 · credits.package_purchase_settled ──────────────────

  /**
   * The receipt for a credit package that has been paid for and loaded.
   *
   * Called after the settling transaction has committed, by both paths that can
   * legitimately produce one: the signature-verified Lemon Squeezy webhook and,
   * in a deployment wired to the mock provider, the in-app payment form. It is
   * never called from inside either transaction, so a settlement that rolls
   * back leaves no message and no audit row behind it.
   *
   * Everything it needs is re-read here from the committed rows, and every one
   * of the three preconditions is checked again rather than trusted from the
   * caller:
   *
   * - the purchase is PAID;
   * - it sold credits (`ONE_TIME_CREDITS`) — a period package moves no balance
   *   and has nothing to say that this message's heading would be true of;
   * - the credit movement exists, and is the PACKAGE_PURCHASE row this purchase
   *   points at. The credits in the message come from that ledger row, so the
   *   figure the provider reads is the figure their balance actually moved by.
   *
   * `dedupeKey` names the purchase. One purchase settles once, so the unique
   * index on (template, dedupeKey) is what makes a redelivered webhook — or a
   * webhook and a mock settlement racing in a misconfigured deployment —
   * produce exactly one receipt.
   */
  async sendPackagePurchaseConfirmation(purchaseId: string) {
    const purchase = await loadPackagePurchase(this.prisma, purchaseId);
    if (!purchase) {
      return;
    }

    const provider = await loadProvider(this.prisma, purchase.providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'package-purchase-confirmation',
      provider.recipient,
      packagePurchaseConfirmationData(provider, purchase),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `package-purchase:${purchase.id}`,
      },
    );
  }

  // ───────────────────────────── vitrin, phase two ────────────────────────────

  /**
   * The placement is live — to the provider who paid for it.
   *
   * Re-reads everything from the committed rows and checks the precondition
   * again rather than trusting the caller: a placement that is not ACTIVE has
   * nothing this message's heading would be true of.
   *
   * `dedupeKey` names the placement. One payment produces one run — the unique
   * index on `purchaseId` says so — and the index on (template, dedupeKey)
   * turns a redelivered webhook into exactly one notice.
   */
  async sendShowcasePlacementActivated(placementId: string) {
    const placement = await loadShowcasePlacement(this.prisma, placementId);
    if (!placement || placement.status !== ShowcasePlacementStatus.ACTIVE) {
      return;
    }

    const provider = await loadProvider(this.prisma, placement.providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'showcase-placement-activated',
      provider.recipient,
      showcasePlacementActivatedData(provider, placement),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-placement-activated:${placement.id}`,
      },
    );
  }

  // ───────────────────────────── vitrin, phase three ──────────────────────────

  /**
   * The package was paid for — to the provider who bought it.
   *
   * Re-reads the committed purchase and the right it granted, and refuses
   * anything that is not a PAID vitrin purchase with a right behind it: the
   * legacy card-bound purchase, which settled straight into a placement, has
   * its own notice and no right to describe.
   *
   * `dedupeKey` names the purchase. One purchase settles once, so a redelivered
   * webhook — or the webhook and the mock form racing — produce one message.
   */
  async sendShowcasePackagePaymentSucceeded(purchaseId: string) {
    const purchase = await loadSettledShowcasePurchase(this.prisma, purchaseId);
    if (!purchase) {
      return;
    }

    const provider = await loadProvider(this.prisma, purchase.providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'showcase-package-payment-succeeded',
      provider.recipient,
      showcasePaymentSucceededData(provider, purchase),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-package-payment-succeeded:${purchase.id}`,
      },
    );
  }

  /**
   * The payment did not complete — to the provider who started it.
   *
   * Only a *payment* failure qualifies: a card the mock form declined, or a
   * pending purchase an operator cancelled. A purchase that failed because the
   * checkout could never be opened — `PACKAGE_NOT_MAPPED`, a provider that was
   * down — is this deployment's configuration problem and is refused here:
   * the provider never reached a payment page, and a message telling them
   * their payment failed would be a lie about their card.
   */
  async sendShowcasePackagePaymentFailed(purchaseId: string) {
    const purchase = await loadFailedShowcasePurchase(this.prisma, purchaseId);
    if (!purchase) {
      return;
    }

    const provider = await loadProvider(this.prisma, purchase.providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'showcase-package-payment-failed',
      provider.recipient,
      showcasePaymentFailedData(provider, purchase),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-package-payment-failed:${purchase.id}`,
      },
    );
  }

  /**
   * A version was approved — one message, whichever of the two facts it
   * produced.
   *
   * The approval is read back from the committed rows, and what the message
   * says follows from what is on the air: a placement ACTIVE on this very
   * version means "approved and live" as a single notice; nothing on the air
   * means "approved", and the way back onto the air is a package. A placement
   * that went up at a *different* moment from the approval is not this
   * method's business — `sendShowcasePlacementActivated` covers it.
   *
   * `dedupeKey` names the version. A version is approved once, so the pair of
   * keys — one per template — makes each approval exactly one message even if
   * the operator's click is replayed.
   */
  async sendShowcaseCardApprovalOutcome(versionId: string) {
    const version = await loadApprovedShowcaseVersion(this.prisma, versionId);
    if (!version) {
      return;
    }

    const provider = await loadProvider(this.prisma, version.card.providerId);
    if (!provider?.recipient) {
      return;
    }

    const live = await loadActivePlacementForVersion(this.prisma, versionId);

    if (live) {
      await this.send(
        'showcase-card-approved-live',
        provider.recipient,
        showcaseCardApprovedLiveData(provider, version, live),
        {
          providerId: provider.id,
          userId: provider.userId,
          dedupeKey: `showcase-card-approved-live:${version.id}`,
        },
      );
      return;
    }

    await this.send(
      'showcase-card-approved',
      provider.recipient,
      showcaseCardApprovedData(provider, version),
      {
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-card-approved:${version.id}`,
      },
    );
  }

  /**
   * A direct lead — to the one business it was addressed to, and to nobody
   * else.
   *
   * This is the message the approval fan-out is deliberately **not** for. A
   * placement's whole promise is that the lead it produces is not shared out,
   * so there is no audience to resolve here and no loop: one recipient, decided
   * by the card's ownership.
   *
   * No customer telephone number and no e-mail address travels. Contact opens
   * through `ContactRevealEvent`, and a direct lead is not an exception to it.
   */
  async sendShowcaseLeadReceived(leadId: string) {
    const lead = await loadShowcaseLead(this.prisma, leadId);
    if (!lead) {
      return;
    }

    const provider = await loadProvider(this.prisma, lead.providerId);
    if (!provider?.recipient) {
      return;
    }

    await this.send(
      'showcase-lead-received',
      provider.recipient,
      {
        fullName: provider.contactName ?? provider.businessName,
        requestNumber: lead.request.requestNumber,
        categoryName: lead.request.category.name,
        locationLabel: describeArea({
          city: lead.request.city,
          district: lead.request.district,
          neighborhood: lead.request.neighborhood,
        }),
        urgencyLabel: showcaseUrgencyLabel(lead.urgencyBucket),
        slaHours: String(lead.slaHoursSnapshot),
        slaDueAt: lead.slaDueAt.toISOString(),
        leadUrl: providerShowcaseLeadUrl(provider.id, lead.id),
        accountUrl: providerAccountUrl(),
      },
      {
        requestId: lead.requestId,
        providerId: provider.id,
        userId: provider.userId,
        dedupeKey: `showcase-lead-received:${lead.id}`,
      },
    );
  }

  /**
   * The deadline passed: the customer's question and the provider's record,
   * both from one call.
   *
   * One event, two messages, and they are sent together for the reason the
   * support-ticket pairs are — a caller that could send half of it eventually
   * would. Each carries its own template and dedupe key, so a replay that
   * managed the customer's copy and failed on the provider's re-sends only the
   * second.
   *
   * The customer's copy is the one that matters: it is the *only* thing that
   * can lead to this request reaching the market, because a breach on its own
   * opens nothing.
   */
  async sendShowcaseLeadBreached(leadId: string) {
    const lead = await loadShowcaseLead(this.prisma, leadId);
    if (!lead || lead.status !== ShowcaseLeadStatus.BREACHED) {
      return;
    }

    const provider = await loadProvider(this.prisma, lead.providerId);
    const slaLabel = `${showcaseUrgencyLabel(lead.urgencyBucket)} — ${lead.slaHoursSnapshot} saat`;

    if (lead.request.customerEmail) {
      await this.send(
        'showcase-lead-breached-customer',
        lead.request.customerEmail,
        {
          fullName: lead.request.customerName,
          requestNumber: lead.request.requestNumber,
          businessName: provider?.businessName ?? null,
          slaLabel,
          slaDueAt: lead.slaDueAt.toISOString(),
          decisionUrl: customerShowcaseDecisionUrl(lead.requestId),
          accountUrl: customerAccountUrl(),
        },
        {
          requestId: lead.requestId,
          userId: lead.request.customerId,
          dedupeKey: `showcase-lead-breached-customer:${lead.id}`,
        },
      );
    }

    if (provider?.recipient) {
      await this.send(
        'showcase-lead-breached-provider',
        provider.recipient,
        {
          fullName: provider.contactName ?? provider.businessName,
          requestNumber: lead.request.requestNumber,
          categoryName: lead.request.category.name,
          slaLabel,
          slaDueAt: lead.slaDueAt.toISOString(),
          leadUrl: providerShowcaseLeadUrl(provider.id, lead.id),
          accountUrl: providerAccountUrl(),
        },
        {
          requestId: lead.requestId,
          providerId: provider.id,
          userId: provider.userId,
          dedupeKey: `showcase-lead-breached-provider:${lead.id}`,
        },
      );
    }
  }

  // ───────────────────────── 17-21 · support tickets ─────────────────────────

  /**
   * A ticket was opened: two messages, and both of them exactly once.
   *
   * The pair is sent from one method rather than two call sites because they
   * are one event, and a caller that could send half of it would eventually
   * send half of it. They still carry a template and a dedupe key each, so the
   * unique index counts them separately: a replay that already sent the owner's
   * copy but failed on the operator's re-sends only the second.
   *
   * Which pair is sent depends on the ticket's desk and on nothing else — see
   * {@link SUPPORT_DESKS}.
   *
   * Called after the creating transaction has committed, like every other
   * method here. A ticket that rolled back has no id worth mailing about.
   */
  async sendSupportTicketOpened(ticketId: string) {
    const ticket = await loadSupportTicket(this.prisma, ticketId);
    if (!ticket) {
      return;
    }

    const desk = SUPPORT_DESKS[ticket.requesterRole];
    const opening = await firstSupportTicketMessage(this.prisma, ticket.id);

    // The operator's copy first: the person waiting has already seen the ticket
    // appear on their own screen, and the mailbox that has to answer has not.
    await this.send(
      desk.newForSupport,
      readSupportInboxEmail(),
      supportInboxData(ticket, {
        messageExcerpt: opening?.body ?? null,
        createdAt: ticket.createdAt.toISOString(),
      }),
      { dedupeKey: `${RETRY_DEDUPE_PREFIXES[desk.newForSupport]}:${ticket.id}` },
    );

    if (!ticket.requesterEmail) {
      return;
    }

    await this.send(
      desk.created,
      ticket.requesterEmail,
      supportRequesterData(ticket, {
        messageExcerpt: opening?.body ?? null,
        createdAt: ticket.createdAt.toISOString(),
      }),
      {
        userId: ticket.requesterId,
        dedupeKey: `${RETRY_DEDUPE_PREFIXES[desk.created]}:${ticket.id}`,
      },
      { replyTo: supportReplyToEmail() },
    );
  }

  /**
   * The person who opened a ticket wrote on it: the support mailbox hears, and
   * nobody else does.
   *
   * Keyed on the message rather than the ticket, because they may write as many
   * times as the ticket's status allows and every one of them is news.
   *
   * The author's role is re-read from the row and then checked against the
   * ticket's own desk, instead of either being trusted from the caller. Two
   * things follow. A message id pointed at this method by mistake — or by a
   * retry rebuilding an old audit row — cannot turn an operator's answer into a
   * "the customer replied" notice, because ADMIN is not a desk. And a message
   * whose author role disagrees with the ticket it sits on, which nothing in
   * this product can write, produces no message at all rather than one filed
   * under the wrong side of the marketplace.
   */
  async sendSupportTicketRequesterMessage(messageId: string) {
    const message = await loadSupportTicketRequesterMessage(this.prisma, messageId);
    if (!message) {
      return;
    }

    const desk = SUPPORT_DESKS[message.ticket.requesterRole];

    await this.send(
      desk.requesterReply,
      readSupportInboxEmail(),
      supportInboxData(message.ticket, {
        messageExcerpt: message.body,
        messageAt: message.createdAt.toISOString(),
      }),
      { dedupeKey: `${RETRY_DEDUPE_PREFIXES[desk.requesterReply]}:${message.id}` },
    );
  }

  /**
   * An operator answered: the person who opened the ticket hears, and hears
   * nothing about who answered.
   *
   * {@link supportRequesterData} is the enforcement rather than a convention —
   * it reads the ticket and the quoted body and has no access to the message's
   * author at all, so there is no field on the payload an operator's identity
   * could arrive in.
   */
  async sendSupportTicketAdminMessage(messageId: string) {
    const message = await loadSupportTicketMessage(
      this.prisma,
      messageId,
      SupportTicketAuthorRole.ADMIN,
    );

    if (!message?.ticket.requesterEmail) {
      return;
    }

    const desk = SUPPORT_DESKS[message.ticket.requesterRole];

    await this.send(
      desk.adminReply,
      message.ticket.requesterEmail,
      supportRequesterData(message.ticket, {
        messageExcerpt: message.body,
        messageAt: message.createdAt.toISOString(),
      }),
      {
        userId: message.ticket.requesterId,
        dedupeKey: `${RETRY_DEDUPE_PREFIXES[desk.adminReply]}:${message.id}`,
      },
      { replyTo: supportReplyToEmail() },
    );
  }

  /**
   * The ticket moved: the customer is told what it moved from and to.
   *
   * Keyed on the recorded change, which is the only thing that makes this
   * countable — a ticket resolved, reopened and resolved again has genuinely
   * changed status three times, and each row is a separate transition with a
   * separate key. A transition the table refused wrote no row, so there is
   * nothing here to mail about.
   *
   * The status printed is the one the change recorded, not the one the ticket
   * holds now. A message that said "çözümlendi" when the operator later closed
   * it would be describing a moment that never existed.
   */
  async sendSupportTicketStatusChanged(statusChangeId: string) {
    const change = await loadSupportTicketStatusChange(this.prisma, statusChangeId);
    if (!change?.ticket.requesterEmail) {
      return;
    }

    const desk = SUPPORT_DESKS[change.ticket.requesterRole];

    await this.send(
      desk.statusChanged,
      change.ticket.requesterEmail,
      supportStatusChangeData(change),
      {
        userId: change.ticket.requesterId,
        dedupeKey: `${RETRY_DEDUPE_PREFIXES[desk.statusChanged]}:${change.id}`,
      },
      { replyTo: supportReplyToEmail() },
    );
  }

  // ─────────────────────────── admin-triggered retry ─────────────────────────

  /**
   * Rebuilds one already-logged message from live domain data.
   *
   * This is the whole of what a retry is allowed to do. It takes no recipient,
   * no template variables and no body from its caller — only the template name
   * and the dedupe key that were written on the audit row when the message was
   * first attempted. The key names the transition ("offer-accepted:<offerId>"),
   * the entity behind it is loaded again here, and the payload is composed by
   * exactly the same builders the first attempt used. An operator therefore
   * cannot influence what a retried message says, and a retried message cannot
   * say something the first one would not have.
   *
   * "Live data" is deliberate in both directions. The guards each transition
   * applies are re-applied: an application that is no longer approved, an offer
   * that is no longer accepted or rejected, a provider who no longer matches
   * the request all compose to null rather than to a message. And contact
   * details are resolved from the ContactRevealEvent again, so a match whose
   * disclosure was never opened — or has since been turned off — is re-rendered
   * without them.
   *
   * Returns null when the message cannot be rebuilt: an unknown or
   * non-reproducible template, a malformed key, a source row that no longer
   * exists, or a recipient the platform no longer holds an address for. The
   * caller records that as a safe failure.
   */
  async composeRetryMessage(
    template: string,
    dedupeKey: string | null,
  ): Promise<NotificationMessage | null> {
    const source = parseRetrySource(template, dedupeKey);
    if (!source) {
      return null;
    }

    const composed = await this.rebuild(source);
    if (!composed) {
      return null;
    }

    return {
      template: source.template,
      to: composed.to,
      subject: transactionalSubject(source.template, composed.data),
      // Carried through the retry: a re-sent support answer that a customer
      // could not reply to would be a different message from the one that
      // failed.
      replyTo: composed.replyTo,
      data: composed.data,
    };
  }

  private async rebuild(source: RetrySource): Promise<ComposedMail | null> {
    switch (source.template) {
      case 'provider-application-received': {
        const provider = await loadProvider(this.prisma, source.ids[0]);
        return provider?.recipient
          ? { to: provider.recipient, data: providerApplicationReceivedData(provider) }
          : null;
      }

      case 'provider-application-approved': {
        const provider = await loadProvider(this.prisma, source.ids[0]);
        // The message says the application was approved, so it may only be
        // rebuilt while that is still true. A suspended or re-rejected
        // application produces nothing.
        if (!provider?.recipient || provider.status !== ProviderStatus.APPROVED) {
          return null;
        }

        return { to: provider.recipient, data: providerApplicationApprovedData(provider) };
      }

      case 'request-received': {
        const request = await loadRequest(this.prisma, source.ids[0]);
        return request?.customerEmail
          ? { to: request.customerEmail, data: requestReceivedData(request) }
          : null;
      }

      case 'request-published': {
        const request = await loadRequest(this.prisma, source.ids[0]);
        // Trimmed, as the outbox trimmed it when it masked the recipient: the
        // delivery compares the rebuilt address's mask against the recorded
        // one, and a stray space would make the intent "unavailable".
        const customerEmail = request?.customerEmail?.trim();
        if (!request || !customerEmail || request.status !== ServiceRequestStatus.APPROVED) {
          return null;
        }

        // The reach is counted again rather than remembered: the number in the
        // message has to be one this platform can stand behind at the moment
        // it is sent.
        const audience = await findMatchingProviders(this.prisma, request);
        return { to: customerEmail, data: requestPublishedData(request, audience.length) };
      }

      case 'request-available': {
        const request = await loadRequest(this.prisma, source.ids[0]);
        if (!request || request.status !== ServiceRequestStatus.APPROVED) {
          return null;
        }

        // Membership is re-derived from the same matcher the discovery screen
        // uses, not taken from the audit row. A provider who has since been
        // suspended, dropped the category or moved out of the area is no longer
        // in the audience and gets nothing.
        const audience = await findMatchingProviders(this.prisma, request);
        const provider = audience.find((candidate) => candidate.id === source.ids[1]);
        if (!provider?.recipient) {
          return null;
        }

        return {
          to: provider.recipient,
          data: requestAvailableData(request, provider, await creditBalance(this.prisma, provider.id)),
        };
      }

      case 'request-expired-customer': {
        const request = await loadRequest(this.prisma, source.ids[0]);
        // The message says the request expired, so it may only be composed
        // while that is still true. Nothing in this product moves a request out
        // of EXPIRED, but the check is what keeps the rebuild honest rather
        // than trusting the audit row's own claim about the past.
        if (
          !request?.customerEmail ||
          request.status !== ServiceRequestStatus.EXPIRED
        ) {
          return null;
        }

        return { to: request.customerEmail, data: requestExpiredCustomerData(request) };
      }

      case 'request-expired-provider': {
        const request = await loadRequest(this.prisma, source.ids[0]);
        if (!request || request.status !== ServiceRequestStatus.EXPIRED) {
          return null;
        }

        // parseRetrySource already refused a key without both segments; the
        // guard is here because the tuple type cannot say so, and a lookup on
        // `undefined` would be a worse way to find that out.
        const providerId = source.ids[1];
        if (!providerId) {
          return null;
        }

        // Eligibility is re-derived here, not taken from the audit row: the
        // provider must still have an offer on this request and it must still
        // not be withdrawn. A provider who took their offer back between the
        // enqueue and the send is no longer in the audience and gets nothing.
        const offerId = await this.prisma.offer
          .findUnique({
            where: { providerId_requestId: { providerId, requestId: request.id } },
            select: { id: true, status: true },
          })
          .then((row) => (row && row.status !== OfferStatus.WITHDRAWN ? row.id : null));

        if (!offerId) {
          return null;
        }

        const offer = await loadOffer(this.prisma, offerId);
        if (!offer) {
          return null;
        }

        const recipient = recipientFor(offer.provider);
        return recipient
          ? { to: recipient, data: requestExpiredProviderData(request, offer) }
          : null;
      }

      case 'offer-received': {
        const offer = await loadOffer(this.prisma, source.ids[0]);
        // An offer the provider has since withdrawn is not news the customer
        // should receive now, however true it was when it was first sent.
        if (!offer?.request.customerEmail || offer.status === OfferStatus.WITHDRAWN) {
          return null;
        }

        return {
          to: offer.request.customerEmail,
          data: offerReceivedData(offer, await countOpenOffers(this.prisma, offer.requestId)),
        };
      }

      case 'match-customer': {
        const offer = await loadOffer(this.prisma, source.ids[0]);
        if (!offer || offer.status !== OfferStatus.ACCEPTED || !offer.request.customerEmail) {
          return null;
        }

        return {
          to: offer.request.customerEmail,
          data: matchCustomerData(
            offer,
            await contactDisclosureFor(this.prisma, offer.requestId, offer.id, offer.providerId),
          ),
        };
      }

      case 'offer-accepted': {
        const offer = await loadOffer(this.prisma, source.ids[0]);
        if (!offer || offer.status !== OfferStatus.ACCEPTED) {
          return null;
        }

        const recipient = recipientFor(offer.provider);
        if (!recipient) {
          return null;
        }

        return {
          to: recipient,
          data: offerAcceptedData(
            offer,
            await contactDisclosureFor(this.prisma, offer.requestId, offer.id, offer.providerId),
          ),
        };
      }

      case 'offer-not-selected': {
        const offer = await loadOffer(this.prisma, source.ids[0]);
        if (!offer || offer.status !== OfferStatus.REJECTED) {
          return null;
        }

        const recipient = recipientFor(offer.provider);
        return recipient ? { to: recipient, data: offerNotSelectedData(offer) } : null;
      }

      case 'package-purchase-confirmation': {
        const purchase = await loadPackagePurchase(this.prisma, source.ids[0]);
        if (!purchase) {
          return null;
        }

        const provider = await loadProvider(this.prisma, purchase.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: packagePurchaseConfirmationData(provider, purchase) }
          : null;
      }

      // The support family, both desks. Each case names the desk its template
      // belongs to and refuses a ticket that is not on it: a key rebuilt into
      // the wrong half of the family would otherwise re-render a hizmet veren's
      // ticket in the hizmet alan's words, which is the one thing a retry must
      // never be able to do. Nothing in this product moves a ticket between
      // desks, so the guard is a statement rather than a case anybody meets.
      case 'support-ticket-created':
      case 'support-ticket-provider-created': {
        const desk = deskOfTemplate(source.template);
        const ticket = await loadSupportTicket(this.prisma, source.ids[0]);
        if (!ticket?.requesterEmail || ticket.requesterRole !== desk) {
          return null;
        }

        const opening = await firstSupportTicketMessage(this.prisma, ticket.id);
        return {
          to: ticket.requesterEmail,
          replyTo: supportReplyToEmail(),
          data: supportRequesterData(ticket, {
            messageExcerpt: opening?.body ?? null,
            createdAt: ticket.createdAt.toISOString(),
          }),
        };
      }

      case 'support-ticket-new-for-support':
      case 'support-ticket-provider-new-for-support': {
        const desk = deskOfTemplate(source.template);
        const ticket = await loadSupportTicket(this.prisma, source.ids[0]);
        if (!ticket || ticket.requesterRole !== desk) {
          return null;
        }

        const opening = await firstSupportTicketMessage(this.prisma, ticket.id);
        // The mailbox is re-read rather than taken from the audit row, which
        // stores no address at all. A deployment that has since moved its
        // support inbox retries to the inbox it has now — and the retry service
        // compares the rebuilt address against the recorded mask, so a move
        // shows up as a refused retry rather than a message to a stranger.
        return {
          to: readSupportInboxEmail(),
          data: supportInboxData(ticket, {
            messageExcerpt: opening?.body ?? null,
            createdAt: ticket.createdAt.toISOString(),
          }),
        };
      }

      case 'support-ticket-customer-reply':
      case 'support-ticket-provider-reply': {
        const desk = deskOfTemplate(source.template);
        const message = await loadSupportTicketRequesterMessage(this.prisma, source.ids[0]);

        return message && message.ticket.requesterRole === desk
          ? {
              to: readSupportInboxEmail(),
              data: supportInboxData(message.ticket, {
                messageExcerpt: message.body,
                messageAt: message.createdAt.toISOString(),
              }),
            }
          : null;
      }

      case 'support-ticket-admin-reply':
      case 'support-ticket-provider-admin-reply': {
        const desk = deskOfTemplate(source.template);
        const message = await loadSupportTicketMessage(
          this.prisma,
          source.ids[0],
          SupportTicketAuthorRole.ADMIN,
        );

        return message?.ticket.requesterEmail && message.ticket.requesterRole === desk
          ? {
              to: message.ticket.requesterEmail,
              replyTo: supportReplyToEmail(),
              data: supportRequesterData(message.ticket, {
                messageExcerpt: message.body,
                messageAt: message.createdAt.toISOString(),
              }),
            }
          : null;
      }

      case 'support-ticket-status-changed':
      case 'support-ticket-provider-status-changed': {
        const desk = deskOfTemplate(source.template);
        const change = await loadSupportTicketStatusChange(this.prisma, source.ids[0]);
        return change?.ticket.requesterEmail && change.ticket.requesterRole === desk
          ? {
              to: change.ticket.requesterEmail,
              replyTo: supportReplyToEmail(),
              data: supportStatusChangeData(change),
            }
          : null;
      }

      case 'showcase-placement-activated': {
        const placement = await loadShowcasePlacement(this.prisma, source.ids[0]);
        if (!placement || placement.status !== ShowcasePlacementStatus.ACTIVE) {
          return null;
        }
        const provider = await loadProvider(this.prisma, placement.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcasePlacementActivatedData(provider, placement) }
          : null;
      }

      case 'showcase-package-payment-succeeded': {
        const purchase = await loadSettledShowcasePurchase(this.prisma, source.ids[0]);
        if (!purchase) {
          return null;
        }
        const provider = await loadProvider(this.prisma, purchase.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcasePaymentSucceededData(provider, purchase) }
          : null;
      }

      case 'showcase-package-payment-failed': {
        const purchase = await loadFailedShowcasePurchase(this.prisma, source.ids[0]);
        if (!purchase) {
          return null;
        }
        const provider = await loadProvider(this.prisma, purchase.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcasePaymentFailedData(provider, purchase) }
          : null;
      }

      case 'showcase-card-approved-live': {
        const version = await loadApprovedShowcaseVersion(this.prisma, source.ids[0]);
        if (!version) {
          return null;
        }
        // The message says the card is on the air, so it may only be rebuilt
        // while that is still true of this very version.
        const live = await loadActivePlacementForVersion(this.prisma, version.id);
        if (!live) {
          return null;
        }
        const provider = await loadProvider(this.prisma, version.card.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcaseCardApprovedLiveData(provider, version, live) }
          : null;
      }

      case 'showcase-card-approved': {
        const version = await loadApprovedShowcaseVersion(this.prisma, source.ids[0]);
        if (!version) {
          return null;
        }
        const provider = await loadProvider(this.prisma, version.card.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcaseCardApprovedData(provider, version) }
          : null;
      }

      case 'showcase-placement-ending-7d':
      case 'showcase-placement-ending-3d': {
        // Composed from the run's *current* clock, and only while the notice
        // is still true: the run is on the air and ends within the window the
        // template names. A run that was suspended, ended or extended past the
        // window in between produces nothing rather than a stale sentence.
        const placement = await loadShowcasePlacement(this.prisma, source.ids[0]);
        const daysLeft = source.template === 'showcase-placement-ending-7d' ? 7 : 3;
        if (
          !placement ||
          placement.status !== ShowcasePlacementStatus.ACTIVE ||
          !endsWithin(placement.endAt, daysLeft, new Date())
        ) {
          return null;
        }
        const provider = await loadProvider(this.prisma, placement.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcasePlacementEndingData(provider, placement) }
          : null;
      }

      case 'showcase-placement-expired': {
        const placement = await loadShowcasePlacement(this.prisma, source.ids[0]);
        if (!placement || placement.status !== ShowcasePlacementStatus.EXPIRED) {
          return null;
        }
        const provider = await loadProvider(this.prisma, placement.providerId);
        return provider?.recipient
          ? { to: provider.recipient, data: showcasePlacementExpiredData(provider, placement) }
          : null;
      }

      case 'credit-refunded': {
        const transaction = await loadRefundTransaction(this.prisma, source.ids[0]);
        if (!transaction) {
          return null;
        }

        const provider = await loadProvider(this.prisma, transaction.providerId);
        if (!provider?.recipient) {
          return null;
        }

        const offer =
          transaction.referenceType === 'Offer' && transaction.referenceId
            ? await loadOffer(this.prisma, transaction.referenceId)
            : null;

        return {
          to: provider.recipient,
          data: creditRefundedData(provider, offer, transaction),
        };
      }
    }
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
    /**
     * The two headers a message can carry beyond its body.
     *
     * An object rather than two positional arguments because they are set by
     * disjoint families — `actionUrl` by the messages that carry a single-use
     * link, `replyTo` by the support-ticket messages a customer may answer —
     * and a call site that had to pass `undefined` past one to reach the other
     * is a call site that will eventually pass it to the wrong one.
     */
    options: { actionUrl?: string; replyTo?: string } = {},
  ) {
    const message = {
      template,
      to,
      subject: transactionalSubject(template, data),
      actionUrl: options.actionUrl,
      replyTo: options.replyTo,
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
export async function findMatchingProviders(
  prisma: Pick<Prisma.TransactionClient, 'serviceRequest' | 'providerProfile'>,
  request: {
    id: string;
    categoryId: string;
    city: string;
    district: string;
    neighborhood: string | null;
  }) {
    // Re-reads the request through the same gate the discovery query applies,
    // so a deployment that requires phone verification does not fan out an
    // unverified request.
    const visible = await prisma.serviceRequest.count({
      where: {
        id: request.id,
        status: ServiceRequestStatus.APPROVED,
        ...phoneVerifiedRequestFilter(),
      },
    });

    if (visible === 0) {
      return [];
    }

    const providers = await prisma.providerProfile.findMany({
      where: {
        status: ProviderStatus.APPROVED,
        // The binding has to be live supply, not release preparation. A DRAFT
        // category's requests are the admin's own smoke tests, and mailing them
        // out would both hand a provider a request they cannot open and put an
        // unreleased service's name in their inbox.
        serviceCategories: {
          some: {
            categoryId: request.categoryId,
            category: { status: { not: ServiceCategoryStatus.DRAFT } },
          },
        },
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
async function contactDisclosureFor(
  prisma: PrismaService,
  requestId: string,
  offerId: string,
  providerId: string,
): Promise<boolean> {
    if (!readContactSharingConfig().enabled) {
      return false;
    }

    const request = await prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { status: true, matchedOfferId: true },
    });

    if (request?.status !== ServiceRequestStatus.MATCHED || request.matchedOfferId !== offerId) {
      return false;
    }

    const reveal = await prisma.contactRevealEvent.findUnique({
      where: { requestId },
      select: { offerId: true, providerId: true },
    });

    return reveal?.offerId === offerId && reveal.providerId === providerId;
  }

async function creditBalance(prisma: PrismaService, providerId: string): Promise<number> {
    const latest = await prisma.providerCreditTransaction.findFirst({
      where: { providerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true },
    });

    return latest?.balanceAfter ?? 0;
  }

async function loadProvider(prisma: PrismaService, providerId: string) {
    const provider = await prisma.providerProfile.findUnique({
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
          // Same rule, on the way out: the category list printed in a
          // provider's own e-mail is their service list, and a draft they were
          // attached to in preparation is not part of it.
          where: { category: { status: { not: ServiceCategoryStatus.DRAFT } } },
          orderBy: { createdAt: 'asc' },
          select: { category: { select: { name: true } } },
        },
        serviceAreas: {
          orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
          select: { city: true, district: true, neighborhood: true },
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
      // The provider's own service areas, so nothing here is a disclosure.
      //
      // Printed with the same sentence every screen uses — "İstanbul geneli",
      // "Kadıköy, İstanbul" — rather than the bare district name it used to be.
      // With one area that read fine; with several it became a list of place
      // names at three different scopes with nothing to tell them apart, so a
      // provider covering all of İstanbul and one covering only Kadıköy were
      // told the same thing.
      areas: joinDistinct(provider.serviceAreas.map(describeArea)),
    };
  }

function loadRequest(prisma: PrismaService, requestId: string) {
    return prisma.serviceRequest.findUnique({
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
        /** Written by the expiry job in the same update that sets EXPIRED. */
        expiredAt: true,
        category: { select: { name: true, offerCreditCost: true } },
      },
    });
  }

function loadOffer(prisma: PrismaService, offerId: string) {
    return prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        requestId: true,
        providerId: true,
        status: true,
        priceAmount: true,
        message: true,
        estimatedStartDate: true,
        // The window this offer was sold under. Every sentence a message prints
        // about the refund promise is built from it, so a provider is never
        // told "48 saat" about an offer created at 72.
        unviewedRefundPolicy: true,
        unviewedRefundWindowHours: true,
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


/**
 * One composed message, before it is handed to the dispatcher.
 *
 * The recipient is resolved here rather than carried on the audit row, because
 * the row deliberately holds only a mask. The retry path re-derives the address
 * from the same domain data the first attempt read, and the caller checks that
 * it still masks to what was recorded before anything is sent.
 */
export type ComposedMail = {
  to: string;
  data: Record<string, string | null | undefined>;
  /** Carried through a retry too: a re-sent support answer must still be answerable. */
  replyTo?: string;
};

// ───────────────────────────── support ticket sources ────────────────────────

/**
 * The columns a support notification is allowed to read.
 *
 * Explicit, and short on purpose. A ticket's own owner is joined for exactly
 * two fields — the name a message greets with and the address it goes to — and
 * nothing else about that account (phone, verification, requests, payments) is
 * selected, so no later edit to this file can widen a support e-mail into an
 * account summary.
 */
const supportTicketSource = {
  id: true,
  subject: true,
  status: true,
  requesterId: true,
  requesterRole: true,
  createdAt: true,
  requester: { select: { name: true, email: true } },
} as const;

type SupportTicketSource = {
  id: string;
  subject: string;
  status: string;
  requesterId: string;
  /**
   * Which desk the ticket sits at, read from the ticket's own snapshot.
   *
   * Every one of the five support messages branches on this and on nothing
   * else — not on the owner's current `User.role`, which can change, and not on
   * anything the caller passed in. A ticket opened by a hizmet veren keeps
   * producing hizmet veren messages for the rest of its life, including on a
   * retry rebuilt years later.
   */
  requesterRole: SupportTicketRequesterRole;
  createdAt: Date;
  requesterName: string | null;
  requesterEmail: string | null;
};

async function loadSupportTicket(
  prisma: PrismaService,
  ticketId: string,
): Promise<SupportTicketSource | null> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: supportTicketSource,
  });

  return ticket ? flattenSupportTicket(ticket) : null;
}

function flattenSupportTicket(ticket: {
  id: string;
  subject: string;
  status: string;
  requesterId: string;
  requesterRole: SupportTicketRequesterRole;
  createdAt: Date;
  requester: { name: string | null; email: string | null };
}): SupportTicketSource {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    requesterId: ticket.requesterId,
    requesterRole: ticket.requesterRole,
    createdAt: ticket.createdAt,
    requesterName: ticket.requester.name,
    requesterEmail: ticket.requester.email,
  };
}

/** The opening message, which is an ordinary message row and always the first one. */
function firstSupportTicketMessage(prisma: PrismaService, ticketId: string) {
  return prisma.supportTicketMessage.findFirst({
    where: { ticketId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { body: true },
  });
}

/**
 * The five support messages, per side of the marketplace.
 *
 * A table rather than five `if`s spread across five methods, so "which template
 * does a hizmet veren's ticket use" is answerable by reading one object, and so
 * a sixth support message cannot be added for one desk and forgotten for the
 * other — the type requires both columns to be filled.
 *
 * Ten templates rather than five parameterised by audience, for the reason the
 * template registry gives about the original five: the two copies a single
 * event produces say different things to different people, and a template that
 * decided at render time which reader it had would be one edit away from
 * telling a hizmet veren what only an operator may read. Here it is stronger
 * still — the hizmet veren copies talk about teklifler and krediler, and the
 * hizmet alan copies about talepler, so they are not the same message with a
 * different word in it.
 *
 * The customer column is exactly the five template names that shipped first.
 * They are untouched on purpose: every existing NotificationLog row, every
 * dedupe key already written and every retry that may still be attempted names
 * one of them, and renaming any of them would orphan all three at once.
 */
const SUPPORT_DESKS: Record<
  SupportTicketRequesterRole,
  {
    /** To the person who opened it, confirming it exists. */
    created: RetryableTransactionalTemplate;
    /** To the support mailbox, announcing it. */
    newForSupport: RetryableTransactionalTemplate;
    /** To the support mailbox, when they write again. */
    requesterReply: RetryableTransactionalTemplate;
    /** To them, when an operator answers. */
    adminReply: RetryableTransactionalTemplate;
    /** To them, when an operator moves the ticket. */
    statusChanged: RetryableTransactionalTemplate;
  }
> = {
  [SupportTicketRequesterRole.CUSTOMER]: {
    created: 'support-ticket-created',
    newForSupport: 'support-ticket-new-for-support',
    requesterReply: 'support-ticket-customer-reply',
    adminReply: 'support-ticket-admin-reply',
    statusChanged: 'support-ticket-status-changed',
  },
  [SupportTicketRequesterRole.PROVIDER]: {
    created: 'support-ticket-provider-created',
    newForSupport: 'support-ticket-provider-new-for-support',
    requesterReply: 'support-ticket-provider-reply',
    adminReply: 'support-ticket-provider-admin-reply',
    statusChanged: 'support-ticket-provider-status-changed',
  },
};

/**
 * The desk a support template belongs to, read back out of the table above.
 *
 * Derived rather than restated, so the two directions cannot disagree: a
 * template that {@link SUPPORT_DESKS} files under PROVIDER is a template this
 * function answers PROVIDER for, by construction. Anything that is not a
 * support template — which the callers' `switch` has already excluded — falls
 * back to CUSTOMER, the desk that existed before there were two.
 */
function deskOfTemplate(template: RetryableTransactionalTemplate): SupportTicketRequesterRole {
  const roles = Object.keys(SUPPORT_DESKS) as SupportTicketRequesterRole[];

  return (
    roles.find((role) =>
      (Object.values(SUPPORT_DESKS[role]) as readonly string[]).includes(template),
    ) ?? SupportTicketRequesterRole.CUSTOMER
  );
}

/** How the two desks are named to an operator reading the inbox copy. */
const SUPPORT_REQUESTER_ROLE_LABELS: Record<SupportTicketRequesterRole, string> = {
  [SupportTicketRequesterRole.CUSTOMER]: 'Hizmet alan',
  [SupportTicketRequesterRole.PROVIDER]: 'Hizmet veren',
};

/**
 * The author role a message from each desk carries.
 *
 * The mirror of the same map in the support module's own service. It is stated
 * again here rather than imported because the two are answering different
 * questions — that one stamps a row, this one checks one — and a shared helper
 * would make a message that disagreed with its ticket unrepresentable in the
 * type system while remaining perfectly representable in the table.
 */
const SUPPORT_AUTHOR_ROLES: Record<SupportTicketRequesterRole, SupportTicketAuthorRole> = {
  [SupportTicketRequesterRole.CUSTOMER]: SupportTicketAuthorRole.CUSTOMER,
  [SupportTicketRequesterRole.PROVIDER]: SupportTicketAuthorRole.PROVIDER,
};

/**
 * One message, and only if it was written by the side the caller expects.
 *
 * The role is a predicate in the query rather than a check afterwards, for the
 * same reason the ticket module puts ownership in its `where`: a row that does
 * not match is simply not found, so there is no branch in which an operator's
 * answer has already been loaded into a "the customer replied" code path.
 */
async function loadSupportTicketMessage(
  prisma: PrismaService,
  messageId: string,
  authorRole: SupportTicketAuthorRole,
) {
  const message = await prisma.supportTicketMessage.findFirst({
    where: { id: messageId, authorRole },
    select: {
      id: true,
      body: true,
      createdAt: true,
      // Deliberately not `authorUserId`, and deliberately no join to the
      // author. The customer's copy of an answer must not be able to name the
      // operator who wrote it, and the surest way to keep it that way is for
      // the operator's identity never to be read at all.
      ticket: { select: supportTicketSource },
    },
  });

  return message ? { ...message, ticket: flattenSupportTicket(message.ticket) } : null;
}

/**
 * One message written by the ticket's own owner, whichever desk that is.
 *
 * The role cannot be a predicate in the query the way it is above, because
 * which role counts depends on the ticket the message sits on — so it is loaded
 * and then required to agree with the ticket's desk. A message whose author
 * role disagrees is not something this product can write; if one is ever found,
 * this returns null and no message is sent, rather than filing it under the
 * side of the marketplace it does not belong to.
 *
 * An ADMIN message never agrees with either desk, which is what keeps an
 * operator's answer out of the "they replied" notice.
 */
async function loadSupportTicketRequesterMessage(prisma: PrismaService, messageId: string) {
  const message = await prisma.supportTicketMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorRole: true,
      // Deliberately not `authorUserId`, for the reason the loader above gives.
      ticket: { select: supportTicketSource },
    },
  });

  if (!message) {
    return null;
  }

  const ticket = flattenSupportTicket(message.ticket);
  if (message.authorRole !== SUPPORT_AUTHOR_ROLES[ticket.requesterRole]) {
    return null;
  }

  return { ...message, ticket };
}

async function loadSupportTicketStatusChange(prisma: PrismaService, statusChangeId: string) {
  const change = await prisma.supportTicketStatusChange.findUnique({
    where: { id: statusChangeId },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
      // `changedById` is not selected: which operator moved the ticket is an
      // internal fact, and this row's only reader is the customer's message.
      ticket: { select: supportTicketSource },
    },
  });

  return change ? { ...change, ticket: flattenSupportTicket(change.ticket) } : null;
}

/**
 * What the three support messages that go to a ticket's owner are told.
 *
 * The ticket, its subject, its status, the quoted message and a link to their
 * own ticket page. There is no operator field on this payload and no way to add
 * one without editing this function, which is the point: the template renders
 * what it is given, so "no operator identity reaches the person who opened the
 * ticket" is enforced where the data is assembled rather than hoped for in six
 * templates.
 *
 * One builder for both desks, unlike the templates: the fields are the same
 * facts about the same ticket, and it is the templates that know what to call
 * them. `ticketUrl` is one link for the same reason — `/destek/:id` is one
 * screen served inside whichever panel the reader belongs to, so there is no
 * second address to get wrong.
 */
function supportRequesterData(ticket: SupportTicketSource, extra: MailData): MailData {
  return {
    fullName: ticket.requesterName,
    ticketReference: ticket.id,
    ticketSubject: ticket.subject,
    status: ticket.status,
    ticketUrl: customerSupportTicketUrl(ticket.id),
    accountUrl: customerAccountUrl(),
    ...extra,
  };
}

/**
 * What the support mailbox's messages are told.
 *
 * The owner's name and address are here and nowhere else — an operator already
 * sees both on the queue screen this message links to, and a notification that
 * withheld them would be a link somebody has to open to find out who is
 * waiting. `accountUrl` is absent: the recipient is a mailbox, not an account
 * with settings.
 *
 * `requesterRoleLabel` is on the payload rather than left to the template
 * because it is a fact about the ticket, not a fact about the message: an
 * operator triaging their inbox should be able to see which desk a mail came
 * from without opening it, and there is exactly one place that decides what
 * each desk is called.
 */
function supportInboxData(ticket: SupportTicketSource, extra: MailData): MailData {
  return {
    fullName: SUPPORT_INBOX_SALUTATION,
    ticketReference: ticket.id,
    ticketSubject: ticket.subject,
    status: ticket.status,
    requesterName: ticket.requesterName,
    requesterEmail: ticket.requesterEmail,
    requesterRoleLabel: SUPPORT_REQUESTER_ROLE_LABELS[ticket.requesterRole],
    ticketUrl: adminSupportTicketUrl(ticket.id),
    accountUrl: null,
    ...extra,
  };
}

/**
 * Who a message to a shared mailbox greets.
 *
 * Every document in this design system opens with exactly one salutation, and
 * the recipient here is a team rather than a person — so the greeting names the
 * team instead of borrowing whichever operator happens to read it.
 */
const SUPPORT_INBOX_SALUTATION = 'Destek Ekibi';

function supportStatusChangeData(change: {
  fromStatus: string | null;
  toStatus: string;
  createdAt: Date;
  ticket: SupportTicketSource;
}): MailData {
  return supportRequesterData(change.ticket, {
    // The statuses the *change* recorded, not the ones the ticket holds now. A
    // ticket resolved and later closed must not rewrite the message that
    // announced the resolution.
    fromStatus: change.fromStatus,
    status: change.toStatus,
    changedAt: change.createdAt.toISOString(),
  });
}


type MailData = ComposedMail['data'];

/** What a freshly received request waits for next; see `sendRequestReceived`. */
export type RequestReceivedNextStep = 'review' | 'verify';

type LoadedProvider = NonNullable<Awaited<ReturnType<typeof loadProvider>>>;
type LoadedRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;
type LoadedOffer = NonNullable<Awaited<ReturnType<typeof loadOffer>>>;
type MatchedProvider = Awaited<ReturnType<typeof findMatchingProviders>>[number];
type RefundTransaction = NonNullable<Awaited<ReturnType<typeof loadRefundTransaction>>>;
type LoadedPackagePurchase = NonNullable<Awaited<ReturnType<typeof loadPackagePurchase>>>;

/**
 * The payload builders.
 *
 * Every one of them is a pure function of already-loaded rows, and every one is
 * the *only* place its template's variables are assembled. That is what makes a
 * retry render identical to the first attempt by construction rather than by
 * review: there is no second copy of these field lists to drift.
 */
function providerApplicationReceivedData(provider: LoadedProvider): MailData {
  return {
    fullName: provider.contactName,
    businessName: provider.businessName,
    categories: provider.categories,
    areas: provider.areas,
    statusLabel: providerStatusLabel(provider.status),
    // Only for an application that already belongs to an account. A guest
    // application is reached through the claim link, not by editing.
    profileUrl: provider.userId ? providerProfileUrl(provider.id) : null,
  };
}

function providerApplicationApprovedData(provider: LoadedProvider): MailData {
  return {
    fullName: provider.contactName,
    businessName: provider.businessName,
    categories: provider.categories,
    areas: provider.areas,
    requestsUrl: providerRequestsUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

function requestReceivedData(request: LoadedRequest): MailData {
  return {
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
  };
}

function requestPublishedData(request: LoadedRequest, reachedProviderCount: number): MailData {
  return {
    fullName: request.customerName,
    requestNumber: request.requestNumber,
    categoryName: request.category.name,
    district: request.district,
    reachedProviderCount: String(reachedProviderCount),
    requestUrl: customerRequestUrl(request.id),
    accountUrl: customerAccountUrl(),
  };
}

function requestExpiredCustomerData(request: LoadedRequest): MailData {
  return {
    fullName: request.customerName,
    requestNumber: request.requestNumber,
    categoryName: request.category.name,
    openDays: String(REQUEST_EXPIRY_DAYS),
    expiredAt: request.expiredAt?.toISOString() ?? null,
    // The catalogue, not the closed request: an expired request has nothing
    // left to do on its own page.
    newRequestUrl: customerNewRequestUrl(),
    accountUrl: customerAccountUrl(),
  };
}

/**
 * The provider half, and the field list is the point of it.
 *
 * Everything here is either the provider's own (their contact name, their offer
 * amount, their refund window) or already on the discovery card they bought the
 * request from (its number, its category, its city and district). No customer
 * name, e-mail, phone, neighbourhood or address note; no other provider's
 * existence, count or price; and no operator — an expiry has none.
 */
function requestExpiredProviderData(request: LoadedRequest, offer: LoadedOffer): MailData {
  return {
    fullName: offer.provider.contactName,
    requestNumber: request.requestNumber,
    categoryName: request.category.name,
    city: request.city,
    district: request.district,
    offerAmountMinor: String(offer.priceAmount),
    // Null for an offer the policy does not govern, and the template then
    // prints no refund note at all rather than a promise this offer never
    // carried.
    refundWindowHours: refundWindowHoursFor(offer),
    requestsUrl: providerRequestsUrl(offer.providerId),
    accountUrl: providerAccountUrl(),
  };
}

function requestAvailableData(
  request: LoadedRequest,
  provider: MatchedProvider,
  providerCreditBalance: number,
): MailData {
  return {
    fullName: provider.contactName,
    requestNumber: request.requestNumber,
    categoryName: request.category.name,
    // City and district only. The neighbourhood, the address note and every
    // customer contact field stay out of a message that reaches everybody who
    // matched.
    city: request.city,
    district: request.district,
    qualityScore: String(request.qualityScore),
    creditCost:
      request.category.offerCreditCost === null
        ? null
        : String(request.category.offerCreditCost),
    creditBalance: String(providerCreditBalance),
    requestUrl: providerRequestUrl(provider.id, request.id),
    accountUrl: providerAccountUrl(),
  };
}

function offerReceivedData(offer: LoadedOffer, openOfferCount: number): MailData {
  return {
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
  };
}

function matchCustomerData(offer: LoadedOffer, disclosed: boolean): MailData {
  return {
    fullName: offer.request.customerName,
    businessName: offer.provider.businessName,
    contactName: disclosed ? offer.provider.contactName : null,
    contactPhone: disclosed ? offer.provider.phone : null,
    acceptedAmountMinor: String(offer.priceAmount),
    requestNumber: offer.request.requestNumber,
    categoryName: offer.request.category.name,
    requestUrl: customerRequestUrl(offer.requestId),
    accountUrl: customerAccountUrl(),
  };
}

function offerAcceptedData(offer: LoadedOffer, disclosed: boolean): MailData {
  return {
    fullName: offer.provider.contactName,
    customerName: disclosed ? offer.request.customerName : null,
    customerPhone: disclosed ? offer.request.customerPhone : null,
    // District and city — what the offer was quoted for. The neighbourhood and
    // the address note are not part of the brief the winning provider
    // receives, on screen or here.
    city: offer.request.city,
    district: offer.request.district,
    acceptedAmountMinor: String(offer.priceAmount),
    preferredDate: offer.request.preferredDate?.toISOString() ?? null,
    urgency: offer.request.urgency,
    requestNumber: offer.request.requestNumber,
    offerUrl: providerOfferUrl(offer.providerId, offer.id),
    accountUrl: providerAccountUrl(),
  };
}

function offerNotSelectedData(offer: LoadedOffer): MailData {
  return {
    fullName: offer.provider.contactName,
    requestNumber: offer.request.requestNumber,
    categoryName: offer.request.category.name,
    offerAmountMinor: String(offer.priceAmount),
    // Null for an offer the policy does not govern, and the template then
    // prints no refund note at all rather than a promise this offer never
    // carried.
    refundWindowHours: refundWindowHoursFor(offer),
    requestsUrl: providerRequestsUrl(offer.providerId),
    accountUrl: providerAccountUrl(),
  };
}

/**
 * The refund window to quote for an offer, or null when there is none to quote.
 *
 * Falls back to the product default only for an in-policy offer whose snapshot
 * predates the column — those were all created under 48 hours, which is what
 * the default says. An out-of-policy offer returns null and is quoted nothing.
 */
function refundWindowHoursFor(offer: {
  unviewedRefundPolicy: boolean;
  unviewedRefundWindowHours: number | null;
}): string | null {
  if (!offer.unviewedRefundPolicy) {
    return null;
  }

  return String(
    offer.unviewedRefundWindowHours ?? DEFAULT_UNVIEWED_OFFER_REFUND_WINDOW_HOURS,
  );
}

function creditRefundedData(
  provider: LoadedProvider,
  offer: LoadedOffer | null,
  transaction: RefundTransaction,
): MailData {
  return {
    fullName: provider.contactName,
    requestNumber: offer?.request.requestNumber ?? null,
    categoryName: offer?.request.category.name ?? null,
    refundReason: knownRefundReasonLabel(
      transaction.reason,
      offer?.unviewedRefundWindowHours ?? null,
    ),
    refundedCredits: String(transaction.amount),
    previousBalance: String(transaction.balanceAfter - transaction.amount),
    currentBalance: String(transaction.balanceAfter),
    creditsUrl: providerCreditsUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/** The customer's own count of offers they can still act on. */
function countOpenOffers(prisma: PrismaService, requestId: string): Promise<number> {
  return prisma.offer.count({
    where: { requestId, status: { not: OfferStatus.WITHDRAWN } },
  });
}

/**
 * The receipt's variables.
 *
 * Six facts and two links, all of them the buyer's own: what they bought, how
 * many credits it added, what they paid and in what currency, the order number
 * they can quote to support, and when it settled. Nothing about the payment
 * provider, the store, the mode, the webhook or the operator crosses into here.
 */
function packagePurchaseConfirmationData(
  provider: LoadedProvider,
  purchase: LoadedPackagePurchase,
): MailData {
  return {
    fullName: provider.contactName,
    packageName: purchase.packageNameSnapshot,
    creditAmount: String(purchase.creditedAmount),
    priceAmountMinor: String(purchase.priceAmountSnapshot),
    currency: purchase.currencySnapshot,
    purchaseNumber: purchase.purchaseNumber,
    paidAt: purchase.paidAt?.toISOString() ?? null,
    creditsUrl: providerCreditsUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

async function loadRefundTransaction(prisma: PrismaService, transactionId: string) {
  const transaction = await prisma.providerCreditTransaction.findUnique({
    where: { id: transactionId },
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

  return transaction?.type === CreditTransactionType.OFFER_REFUND ? transaction : null;
}

/**
 * A settled credit-package purchase, or null.
 *
 * Null for anything the receipt would misdescribe: a purchase that is not PAID,
 * one that sold a period rather than credits, or one whose ledger row is
 * missing or is not the PACKAGE_PURCHASE movement it claims. The credits the
 * message states come from that row rather than from the purchase snapshot, so
 * there is no version of this message that names an amount the balance did not
 * move by.
 *
 * The payment columns are not selected at all — no correlation token, no
 * provider order or checkout id, no failure code, no admin note. Nothing that
 * is not selected can be interpolated by mistake.
 */
async function loadPackagePurchase(prisma: PrismaService, purchaseId: string) {
  const purchase = await prisma.packagePurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      providerId: true,
      status: true,
      purchaseNumber: true,
      packageNameSnapshot: true,
      priceAmountSnapshot: true,
      currencySnapshot: true,
      paidAt: true,
      creditTransactionId: true,
      package: { select: { type: true } },
    },
  });

  // A vitrin purchase has no `package` at all and no credit transaction, so it
  // falls out here — which is correct: it loaded no balance, and this receipt's
  // heading would be a false statement about it. Its own notice is
  // `sendShowcasePlacementActivated`.
  if (
    !purchase ||
    purchase.status !== PackagePurchaseStatus.PAID ||
    purchase.package?.type !== OfferPackageType.ONE_TIME_CREDITS ||
    !purchase.creditTransactionId
  ) {
    return null;
  }

  const ledgerEntry = await prisma.providerCreditTransaction.findUnique({
    where: { id: purchase.creditTransactionId },
    select: { id: true, type: true, amount: true, providerId: true },
  });

  if (
    ledgerEntry?.type !== CreditTransactionType.PACKAGE_PURCHASE ||
    ledgerEntry.providerId !== purchase.providerId
  ) {
    return null;
  }

  return { ...purchase, creditedAmount: ledgerEntry.amount };
}

/**
 * The templates a retry may rebuild, and the dedupe-key prefix each one writes.
 *
 * Membership of this table *is* the reproducibility rule, and both halves
 * matter:
 *
 * - A template is here only if its message can be composed again from
 *   persisted domain data. The password reset, the e-mail verification, the
 *   guest activation and the provider claim are absent and must stay absent:
 *   each carries a single-use token that exists in memory for the length of
 *   the issuing transaction and is stored nowhere, so there is nothing to
 *   rebuild from and a "retry" could only mean minting a new secret — which is
 *   the user's own request to make, not an operator's.
 * - The prefix is what turns the audit row back into a source entity. It is
 *   the key the first attempt wrote, so a row whose key does not match its
 *   template is not rebuilt at all.
 */
const RETRY_DEDUPE_PREFIXES = {
  'provider-application-received': 'application-received',
  'provider-application-approved': 'application-approved',
  'request-received': 'request-received',
  'request-published': 'request-published',
  'offer-received': 'offer-received',
  'match-customer': 'match-customer',
  'request-available': 'request-available',
  'offer-accepted': 'offer-accepted',
  'offer-not-selected': 'offer-not-selected',
  'credit-refunded': 'credit-refunded',
  'package-purchase-confirmation': 'package-purchase',
  // The two halves of an expiry. Reproducible in full — both are composed from
  // the request row and, for the provider, their own offer, all of which
  // persist — and reproducible is not optional for these two: the expiry
  // outbox rebuilds them from exactly this table when it delivers an intent
  // some earlier tick enqueued but never sent. The prefixes are the dedupe
  // keys themselves, unchanged, so rows written before the outbox existed
  // rebuild the same way.
  'request-expired-customer': 'request-expired-customer',
  'request-expired-provider': 'request-expired-provider',
  // The support-ticket family is reproducible in full: every one of them is
  // composed from a ticket, a message or a status-change row, all of which are
  // permanent — this product deletes none of the three — and none of them
  // carries a token or anything else that existed only in memory.
  'support-ticket-created': 'support-ticket-created',
  'support-ticket-new-for-support': 'support-ticket-new',
  'support-ticket-customer-reply': 'support-ticket-customer-reply',
  'support-ticket-admin-reply': 'support-ticket-admin-reply',
  'support-ticket-status-changed': 'support-ticket-status',
  // The hizmet veren half of the same family, and prefixes of their own rather
  // than a shared one per event. A dedupe key is what a retry is rebuilt from,
  // so a key that did not say which desk it came from would be a key two
  // templates could both claim — and the retry would then be free to re-render
  // a hizmet veren's ticket with the hizmet alan's words.
  'support-ticket-provider-created': 'support-ticket-provider-created',
  'support-ticket-provider-new-for-support': 'support-ticket-provider-new',
  'support-ticket-provider-reply': 'support-ticket-provider-reply',
  'support-ticket-provider-admin-reply': 'support-ticket-provider-admin-reply',
  'support-ticket-provider-status-changed': 'support-ticket-provider-status',
  // The vitrin run's life. Every one of these is composed from a placement, a
  // purchase or a card version — rows this product never deletes — and the
  // three clock notices are not merely retryable but *delivered* through this
  // table: the lifecycle outbox enqueues them inside the job's transaction and
  // rebuilds them from exactly these prefixes when it sends.
  'showcase-placement-activated': 'showcase-placement-activated',
  'showcase-package-payment-succeeded': 'showcase-package-payment-succeeded',
  'showcase-package-payment-failed': 'showcase-package-payment-failed',
  'showcase-card-approved-live': 'showcase-card-approved-live',
  'showcase-card-approved': 'showcase-card-approved',
  'showcase-placement-ending-7d': 'showcase-placement-ending-7d',
  'showcase-placement-ending-3d': 'showcase-placement-ending-3d',
  'showcase-placement-expired': 'showcase-placement-expired',
} as const satisfies Partial<Record<TransactionalEmailTemplate, string>>;

export type RetryableTransactionalTemplate = keyof typeof RETRY_DEDUPE_PREFIXES;

export const RETRYABLE_TRANSACTIONAL_TEMPLATES = Object.keys(
  RETRY_DEDUPE_PREFIXES,
) as readonly RetryableTransactionalTemplate[];

export function isRetryableTransactionalTemplate(
  value: string,
): value is RetryableTransactionalTemplate {
  return Object.prototype.hasOwnProperty.call(RETRY_DEDUPE_PREFIXES, value);
}

type RetrySource = {
  template: RetryableTransactionalTemplate;
  /** At least one, and exactly RETRY_SOURCE_ID_COUNT[template] of them. */
  ids: readonly [string, ...string[]];
};

/** How many ids each key carries after its prefix. */
const RETRY_SOURCE_ID_COUNT: Record<RetryableTransactionalTemplate, number> = {
  'provider-application-received': 1,
  'provider-application-approved': 1,
  'request-received': 1,
  'request-published': 1,
  'offer-received': 1,
  'match-customer': 1,
  'request-available': 2,
  'offer-accepted': 1,
  'offer-not-selected': 1,
  'credit-refunded': 1,
  'package-purchase-confirmation': 1,
  'request-expired-customer': 1,
  /** The request and the provider: one notice per bidder, not one per expiry. */
  'request-expired-provider': 2,
  'support-ticket-created': 1,
  'support-ticket-new-for-support': 1,
  'support-ticket-customer-reply': 1,
  'support-ticket-admin-reply': 1,
  'support-ticket-status-changed': 1,
  'support-ticket-provider-created': 1,
  'support-ticket-provider-new-for-support': 1,
  'support-ticket-provider-reply': 1,
  'support-ticket-provider-admin-reply': 1,
  'support-ticket-provider-status-changed': 1,
  'showcase-placement-activated': 1,
  'showcase-package-payment-succeeded': 1,
  'showcase-package-payment-failed': 1,
  'showcase-card-approved-live': 1,
  'showcase-card-approved': 1,
  'showcase-placement-ending-7d': 1,
  'showcase-placement-ending-3d': 1,
  'showcase-placement-expired': 1,
};

/**
 * Reads the source entity back out of an audit row.
 *
 * Two keys carry a trailing timestamp ("application-approved:<id>:<when>",
 * "request-published:<id>:<when>") because the transition can legitimately
 * recur. Only the ids are taken; the timestamp distinguishes rows and never
 * appears in a message.
 *
 * Every segment is checked against the shape this codebase's ids have. The key
 * comes from the database rather than from a request, but it is the one value
 * on the path that a much older row could have written under different rules,
 * and an id is about to be looked up with it.
 */
function parseRetrySource(template: string, dedupeKey: string | null): RetrySource | null {
  if (!dedupeKey || !isRetryableTransactionalTemplate(template)) {
    return null;
  }

  const prefix = `${RETRY_DEDUPE_PREFIXES[template]}:`;
  if (!dedupeKey.startsWith(prefix)) {
    return null;
  }

  const expected = RETRY_SOURCE_ID_COUNT[template];
  const ids = dedupeKey.slice(prefix.length).split(':').slice(0, expected);

  if (ids.length !== expected || !ids.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    return null;
  }

  return { template, ids: ids as [string, ...string[]] };
}

/**
 * Where a provider's mail goes: the owning account's address, falling back to
 * the application's own contact field only when there is no account.
 *
 * This order is a correction, and the reason is worth stating.
 *
 * It used to be the other way round, on the documented assumption that "the
 * claim flow pins the application address to the owner's address once ownership
 * is granted — so for a claimed profile the two are the same value anyway".
 * That is true only of profiles that arrived through the claim flow. A provider
 * who registers directly owns their profile from the first moment and never
 * passes through it, so the two fields are simply two independent values: the
 * address they sign in with, and whatever they typed into a form field once.
 * Preferring the form field meant the platform mailed an address the provider
 * may never read, had never confirmed, and cannot correct by fixing their
 * account — while NotificationLog recorded the send as successful.
 *
 * The account address is the one the platform actually knows to be theirs: it
 * is unique across accounts, it is what a password reset and an e-mail
 * verification go to, and it is what they use to log in and read the panel the
 * message links to.
 *
 * The application address still leads for a *guest* application, because there
 * is no account behind it yet and it is the only address there is. That is the
 * case the claim invitation is for, and it is unchanged.
 */
export function recipientFor(provider: {
  email: string | null;
  user?: { email: string | null } | null;
}): string | null {
  const candidate = provider.user?.email?.trim() || provider.email?.trim();
  return candidate ? candidate : null;
}

/**
 * The stored refund reason is the policy code — today always
 * `UNVIEWED_OFFER_48H`, since the automatic worker is the only writer of refund
 * rows. Historical rows from the removed manual path carry `"<CODE>: <free
 * text>"`, where the free text can be an admin's internal note, so only the
 * code is ever read and only when it is one this build knows. Anything else
 * yields null and the row disappears, rather than putting an internal note in a
 * provider's inbox.
 */
function knownRefundReasonLabel(
  stored: string | null,
  windowHours: number | null,
): string | null {
  const code = stored?.split(':', 1)[0]?.trim();
  if (!code) {
    return null;
  }

  // The offer's own window, so the reason a provider reads names the term they
  // were actually sold. Only the automatic code consults it; the manual prefix
  // renders as "Yönetici kredi iadesi" and never as an operations reason code
  // or an admin's note.
  const label = refundReasonLabel(code, windowHours);
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

/**
 * How an urgency bucket reads to a person.
 *
 * One function, so the provider's inbox, the customer's message and the
 * screens all print the same two words. The hours are never baked in here —
 * they come from the card's own version and travel beside this label.
 */
function showcaseUrgencyLabel(bucket: ShowcaseLeadUrgency): string {
  return bucket === ShowcaseLeadUrgency.URGENT ? 'Acil' : 'Normal';
}

function loadShowcasePlacement(prisma: PrismaService, placementId: string) {
  return prisma.showcasePlacement.findUnique({
    where: { id: placementId },
    select: {
      id: true,
      status: true,
      providerId: true,
      packageNameSnapshot: true,
      startAt: true,
      endAt: true,
      pinnedVersion: { select: { title: true } },
      shelves: {
        orderBy: [{ city: 'asc' }, { district: 'asc' }, { neighborhood: 'asc' }],
        select: { city: true, district: true, neighborhood: true },
      },
    },
  });
}

type ShowcasePlacementSource = NonNullable<Awaited<ReturnType<typeof loadShowcasePlacement>>>;
type ShowcaseProviderSource = NonNullable<Awaited<ReturnType<typeof loadProvider>>>;

/** The run's areas as one sentence, in the words the screens use. */
function showcaseAreaSummary(placement: ShowcasePlacementSource): string {
  return placement.shelves
    .map((shelf) =>
      describeArea({
        city: shelf.city,
        district: shelf.district,
        neighborhood: shelf.neighborhood,
      }),
    )
    .join(' · ');
}

function showcasePlacementActivatedData(
  provider: ShowcaseProviderSource,
  placement: ShowcasePlacementSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    cardTitle: placement.pinnedVersion.title,
    packageName: placement.packageNameSnapshot,
    areaSummary: showcaseAreaSummary(placement),
    startAt: placement.startAt.toISOString(),
    endAt: placement.endAt.toISOString(),
    placementUrl: providerShowcaseUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/** Whether a run ends inside the next `days` — the window a reminder names. */
export function endsWithin(endAt: Date, days: number, now: Date): boolean {
  const remaining = endAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= days * 24 * 60 * 60 * 1000;
}

function showcasePlacementEndingData(
  provider: ShowcaseProviderSource,
  placement: ShowcasePlacementSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    cardTitle: placement.pinnedVersion.title,
    endAt: placement.endAt.toISOString(),
    packagesUrl: providerShowcasePackagesUrl(provider.id),
    showcaseUrl: providerShowcaseUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

function showcasePlacementExpiredData(
  provider: ShowcaseProviderSource,
  placement: ShowcasePlacementSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    cardTitle: placement.pinnedVersion.title,
    endAt: placement.endAt.toISOString(),
    packagesUrl: providerShowcasePackagesUrl(provider.id),
    showcaseUrl: providerShowcaseUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/**
 * A PAID package-first vitrin purchase and the right it granted.
 *
 * The payment columns are not selected — no order id, no checkout id, no
 * correlation token, no failure code, no admin note — so nothing on the
 * payment side can reach a template by accident. A legacy card-bound purchase
 * has no right and falls out; its notice is the placement's.
 */
async function loadSettledShowcasePurchase(prisma: PrismaService, purchaseId: string) {
  const purchase = await prisma.packagePurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      kind: true,
      providerId: true,
      status: true,
      packageNameSnapshot: true,
      priceAmountSnapshot: true,
      currencySnapshot: true,
      durationDaysSnapshot: true,
      paidAt: true,
      showcaseEntitlement: { select: { expiresAt: true } },
    },
  });

  if (
    !purchase ||
    purchase.kind !== PackagePurchaseKind.SHOWCASE_PACKAGE ||
    purchase.status !== PackagePurchaseStatus.PAID ||
    !purchase.showcaseEntitlement
  ) {
    return null;
  }

  return { ...purchase, entitlement: purchase.showcaseEntitlement };
}

type SettledShowcasePurchaseSource = NonNullable<
  Awaited<ReturnType<typeof loadSettledShowcasePurchase>>
>;

function showcasePaymentSucceededData(
  provider: ShowcaseProviderSource,
  purchase: SettledShowcasePurchaseSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    packageName: purchase.packageNameSnapshot,
    durationDays:
      purchase.durationDaysSnapshot === null ? null : String(purchase.durationDaysSnapshot),
    priceAmountMinor: String(purchase.priceAmountSnapshot),
    currency: purchase.currencySnapshot,
    entitlementExpiresAt: purchase.entitlement.expiresAt.toISOString(),
    paidAt: purchase.paidAt?.toISOString() ?? null,
    createCardUrl: providerShowcaseNewCardUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/**
 * A vitrin purchase whose *payment* failed or was cancelled.
 *
 * `paymentFailureCode` is selected for one comparison and never returned: it is
 * set only by the checkout-opening path, when no payment page ever opened, and
 * a purchase carrying one is refused here. The mock decline and an operator's
 * cancellation leave it null, and those are the two real failures.
 */
async function loadFailedShowcasePurchase(prisma: PrismaService, purchaseId: string) {
  const purchase = await prisma.packagePurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      kind: true,
      providerId: true,
      status: true,
      packageNameSnapshot: true,
      priceAmountSnapshot: true,
      currencySnapshot: true,
      failedAt: true,
      cancelledAt: true,
      paymentFailureCode: true,
    },
  });

  if (!purchase || purchase.kind !== PackagePurchaseKind.SHOWCASE_PACKAGE) {
    return null;
  }

  const failed =
    purchase.status === PackagePurchaseStatus.FAILED && purchase.paymentFailureCode === null;
  const cancelled = purchase.status === PackagePurchaseStatus.CANCELLED;

  if (!failed && !cancelled) {
    return null;
  }

  const { paymentFailureCode: _code, ...rest } = purchase;
  return { ...rest, attemptedAt: purchase.failedAt ?? purchase.cancelledAt ?? null };
}

type FailedShowcasePurchaseSource = NonNullable<
  Awaited<ReturnType<typeof loadFailedShowcasePurchase>>
>;

function showcasePaymentFailedData(
  provider: ShowcaseProviderSource,
  purchase: FailedShowcasePurchaseSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    packageName: purchase.packageNameSnapshot,
    priceAmountMinor: String(purchase.priceAmountSnapshot),
    currency: purchase.currencySnapshot,
    attemptedAt: purchase.attemptedAt?.toISOString() ?? null,
    packagesUrl: providerShowcasePackagesUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/** An APPROVED version and the card it belongs to. Nothing else qualifies. */
async function loadApprovedShowcaseVersion(prisma: PrismaService, versionId: string) {
  const version = await prisma.showcaseCardVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      title: true,
      reviewStatus: true,
      publishedAt: true,
      card: { select: { id: true, providerId: true } },
    },
  });

  return version && version.reviewStatus === ShowcaseVersionReview.APPROVED ? version : null;
}

type ApprovedShowcaseVersionSource = NonNullable<
  Awaited<ReturnType<typeof loadApprovedShowcaseVersion>>
>;

/** The run publishing this exact version right now, if there is one. */
async function loadActivePlacementForVersion(prisma: PrismaService, versionId: string) {
  const placement = await prisma.showcasePlacement.findFirst({
    where: { pinnedVersionId: versionId, status: ShowcasePlacementStatus.ACTIVE },
    orderBy: { startAt: 'desc' },
    select: { id: true },
  });

  return placement ? loadShowcasePlacement(prisma, placement.id) : null;
}

function showcaseCardApprovedLiveData(
  provider: ShowcaseProviderSource,
  version: ApprovedShowcaseVersionSource,
  placement: ShowcasePlacementSource,
) {
  // A run that started before this version was approved is one the approval
  // re-pinned: the provider is reading about an edit, not a launch.
  const revision =
    version.publishedAt !== null && placement.startAt.getTime() < version.publishedAt.getTime();

  return {
    fullName: provider.contactName ?? provider.businessName,
    cardTitle: version.title,
    packageName: placement.packageNameSnapshot,
    areaSummary: showcaseAreaSummary(placement),
    startAt: placement.startAt.toISOString(),
    endAt: placement.endAt.toISOString(),
    revision: revision ? 'true' : 'false',
    cardUrl: providerShowcaseCardUrl(provider.id, version.card.id),
    accountUrl: providerAccountUrl(),
  };
}

function showcaseCardApprovedData(
  provider: ShowcaseProviderSource,
  version: ApprovedShowcaseVersionSource,
) {
  return {
    fullName: provider.contactName ?? provider.businessName,
    cardTitle: version.title,
    approvedAt: version.publishedAt?.toISOString() ?? null,
    showcaseUrl: providerShowcaseUrl(provider.id),
    accountUrl: providerAccountUrl(),
  };
}

/**
 * Everything a vitrin notification needs, and nothing it does not.
 *
 * `customerPhone` is deliberately absent even though both messages are about a
 * customer's request: the provider's copy renders no contact detail, and a
 * projection that carried one would be one template edit away from putting it
 * in an inbox before the reveal.
 */
function loadShowcaseLead(prisma: PrismaService, leadId: string) {
  return prisma.showcaseLead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      status: true,
      providerId: true,
      requestId: true,
      urgencyBucket: true,
      slaHoursSnapshot: true,
      slaDueAt: true,
      request: {
        select: {
          requestNumber: true,
          customerId: true,
          customerName: true,
          customerEmail: true,
          city: true,
          district: true,
          neighborhood: true,
          category: { select: { name: true } },
        },
      },
    },
  });
}
