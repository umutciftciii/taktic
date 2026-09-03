import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  OfferEntitlementSource,
  OfferRejectionReason,
  OfferStatus,
  Prisma,
  ServiceRequestStatus,
  UserRole,
} from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  contactDisclosureRequiredException,
  contactDisclosureSupersededException,
  readContactSharingConfig,
} from '../contact-sharing/contact-sharing.config';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { CustomerOfferActionDto } from './dto/customer-offer-action.dto';
import {
  ADMIN_OFFER_ACTIONS,
  CUSTOMER_UNACTIONABLE_OFFER_STATUSES,
  isAdminSettableOfferStatus,
  offerStatusNotSettableException,
} from './offer-transitions';
import { calculateRefundEligibility } from './refund-policy';

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
  private readonly logger = new Logger(OffersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
  ) {}

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

  /**
   * The admin offer screen's status control.
   *
   * It no longer writes `Offer.status`. It used to, unconditionally and for all
   * eight states, which made it a second execution path for rules that live in
   * one place: an ACCEPTED written here left the request unmatched, the
   * competing offers open, no ContactRevealEvent on file and nobody told; a
   * REJECTED written here skipped the "your offer was not selected" message
   * entirely. Two doors to one state change, one of them with no guards behind
   * it, is the bypass this method exists to close.
   *
   * What it does instead is name an action and hand it to
   * {@link updateRequestOfferAction} — the same method the customer screen
   * calls, which SUPER_ADMIN is already permitted to call through the
   * service-request route. So the authority here is unchanged and the cascade,
   * the concurrency guards and the message matrix are the production ones.
   *
   * Statuses outside {@link ADMIN_OFFER_ACTIONS} are refused with a 400 rather
   * than silently ignored; see that map for why each one is absent.
   *
   * The response stays the admin projection it has always been, re-read after
   * the transition, so the endpoint's contract does not change.
   */
  async updateOfferStatus(id: string, status: OfferStatus, user: AuthUser | null = null) {
    if (!isAdminSettableOfferStatus(status)) {
      throw offerStatusNotSettableException(status);
    }

    const offer = await this.ensureOfferExists(id);

    await this.updateRequestOfferAction(
      offer.requestId,
      id,
      { action: ADMIN_OFFER_ACTIONS[status] },
      user,
    );

    return this.getOffer(id);
  }

  /**
   * Runs a notification and swallows whatever it throws. Every caller is past
   * its commit point, so an escaping error could only turn a completed action
   * into a failed response.
   */
  private async notify(run: () => Promise<unknown>, subject: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a notification for ${subject}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
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
      submittedAt: offer.submittedAt,
    }));
  }

  async getRequestOffer(requestId: string, offerId: string, user: AuthUser | null = null) {
    const offer = await this.getRequestOfferOrThrow(requestId, offerId, user);
    return toCustomerOfferDetail(offer);
  }

  /**
   * The single point at which an offer becomes "viewed".
   *
   * This endpoint — POST /service-requests/:requestId/offers/:offerId/view — is
   * the only writer of `Offer.viewedAt` that a customer can reach, and
   * `viewedAt` is now the whole refund policy: an offer with a timestamp here
   * keeps its credit forever, one without it is paid back after 48 hours. So
   * everything about this method is about not writing that timestamp by
   * accident.
   *
   * Who counts is decided by {@link isCustomerViewer}, not by the access guard.
   * `getRequestOfferOrThrow` also admits a SUPER_ADMIN, deliberately, so support
   * can read a customer's screen — but an admin reading it is not the customer
   * looking at the offer, and a support ticket must not cost a provider a
   * refund. Nothing else stamps it either: listing offers, the provider's own
   * panel and every admin projection are reads.
   *
   * The stamp itself is a conditional UPDATE on `viewedAt IS NULL`, so of any
   * number of simultaneous opens exactly one row-write wins and the recorded
   * first view is the first one — a re-open, a refresh or a double-submitted
   * request changes nothing.
   */
  async markRequestOfferViewed(requestId: string, offerId: string, user: AuthUser | null = null) {
    const existingOffer = await this.getRequestOfferOrThrow(requestId, offerId, user);

    if (isCustomerViewer(existingOffer.request.customerId, user)) {
      // Two conditional writes rather than one read-then-write: the row was read
      // outside any transaction and is already stale. Each clause is its own
      // guard, so a concurrent open cannot move a timestamp that is already set.
      await this.prisma.offer.updateMany({
        where: { id: offerId, viewedAt: null },
        data: { viewedAt: new Date() },
      });

      await this.prisma.offer.updateMany({
        where: { id: offerId, status: OfferStatus.SUBMITTED },
        data: { status: OfferStatus.VIEWED },
      });
    }

    const offer = await this.prisma.offer.findUniqueOrThrow({
      where: { id: offerId },
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

    // Acting on an offer implies having read it — but only when it is the
    // customer acting. A SUPER_ADMIN reaches this same method through the admin
    // status control, and an admin's decision is not the customer's view, so it
    // must not close a provider's refund window. Same predicate the view
    // endpoint uses, for the same reason.
    const stampViewedAt =
      existingOffer.viewedAt === null && isCustomerViewer(existingOffer.request.customerId, user);

    if (status === OfferStatus.ACCEPTED) {
      const accepted = await this.acceptRequestOffer(requestId, offerId, stampViewedAt, {
        accepted: dto.contactDisclosureAccepted === true,
        version: dto.contactDisclosureVersion?.trim().toLowerCase() || null,
      });

      // Both halves of the match, then the offers the cascade closed. All of it
      // after the transaction committed, and each message keyed on its own
      // offer, so a retry of this request re-sends nothing.
      await this.notify(() => this.mail.sendMatchNotifications(offerId), `offer ${offerId}`);
      await this.notify(
        () => this.mail.sendOfferNotSelected(accepted.rejectedOfferIds),
        `request ${requestId}`,
      );

      return accepted.detail;
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
        ...(stampViewedAt ? { viewedAt: now } : {}),
        // A hand-rejected offer deliberately gets no rejectionReason: the enum
        // records why the platform closed an offer, and nothing closed this
        // one. It no longer affects refunds either way — under the 48-hour rule
        // only `viewedAt` does.
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

    // A hand-rejected offer earns the same message the cascade sends. A
    // shortlisted one does not: nothing has been decided yet.
    if (status === OfferStatus.REJECTED) {
      await this.notify(() => this.mail.sendOfferNotSelected([offerId]), `offer ${offerId}`);
    }

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
   *
   * When contact sharing is on, the same transaction also carries the reveal:
   * the customer's confirmation of the current disclosure version is required
   * and recorded, and the audit row is written before the transaction commits.
   * All of it therefore succeeds together or not at all — there is no matched
   * request whose contact details are open without a record of why, and no
   * recorded consent for a match that did not happen.
   */
  private acceptRequestOffer(
    requestId: string,
    offerId: string,
    stampViewedAt: boolean,
    disclosure: { accepted: boolean; version: string | null },
  ) {
    const now = new Date();
    const contactSharing = readContactSharingConfig();

    return runSerializable(
      this.prisma,
      async (tx) => {
        if (contactSharing.enabled) {
          // A client that confirms wording this deployment has since replaced is
          // sent back to read the current text, rather than having its answer
          // filed against a version it never saw. Checked before the stored
          // acceptance so a stale screen gets the accurate message.
          if (disclosure.accepted && disclosure.version && disclosure.version !== contactSharing.disclosureVersion) {
            throw contactDisclosureSupersededException();
          }

          // Read inside the transaction, before anything is written. Either the
          // customer confirmed on the accept screen just now, or the request
          // already carries an acceptance of this exact version from when it was
          // submitted. Without one of the two the request is not matched at all,
          // because matching is what opens the details.
          const stored = await tx.serviceRequest.findUnique({
            where: { id: requestId },
            select: { contactDisclosureVersion: true, contactDisclosureAcceptedAt: true },
          });

          const alreadyOnFile =
            Boolean(stored?.contactDisclosureAcceptedAt) &&
            stored?.contactDisclosureVersion === contactSharing.disclosureVersion;

          if (!disclosure.accepted && !alreadyOnFile) {
            throw contactDisclosureRequiredException();
          }

          if (disclosure.accepted && !alreadyOnFile) {
            // Recorded from configuration, never from the client, and inside the
            // accept transaction — so a consent on file always belongs to a
            // match that really happened.
            await tx.serviceRequest.update({
              where: { id: requestId },
              data: {
                contactDisclosureVersion: contactSharing.disclosureVersion,
                contactDisclosureAcceptedAt: now,
              },
            });
          }
        }

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
            ...(stampViewedAt ? { viewedAt: now } : {}),
          },
        });

        if (acceptedUpdate.count !== 1) {
          throw new ConflictException('This offer can no longer be accepted');
        }

        // Only offers still in play are closed. WITHDRAWN, CANCELLED, EXPIRED
        // and any already REJECTED offer are terminal and left untouched.
        //
        // Read before the update, inside the same Serializable transaction, so
        // the list is exactly the set this cascade closed — the providers who
        // are then told they were not selected, and nobody else. A provider who
        // withdrew is not in it, which is the one mistake that message must not
        // make.
        const closing = await tx.offer.findMany({
          where: {
            requestId,
            id: { not: offerId },
            status: {
              in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED],
            },
          },
          select: { id: true },
        });

        await tx.offer.updateMany({
          where: {
            requestId,
            id: { in: closing.map((entry) => entry.id) },
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

        if (contactSharing.enabled) {
          await createContactRevealEvent(tx, {
            requestId,
            offerId,
            providerId: accepted.providerId,
            customerUserId: accepted.request.customerId,
            revealedAt: now,
            disclosureVersion: contactSharing.disclosureVersion,
          });
        }

        return {
          detail: toCustomerOfferDetail(accepted),
          rejectedOfferIds: closing.map((entry) => entry.id),
        };
      },
      { label: 'offers.acceptRequestOffer' },
    );
  }

  private async ensureOfferExists(id: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      // `requestId` comes back so an admin action can be routed onto the
      // canonical request-scoped path without the caller having to know it.
      select: { id: true, requestId: true, viewedAt: true },
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

/**
 * Writes the one audit row that says a match opened both sides' details.
 *
 * Inside the caller's transaction, so a failure here rolls the whole accept
 * back: a matched request without its event would be exactly the state this
 * feature must never produce. The unique index on requestId is what makes that
 * true even against a concurrent writer — the loser's insert fails and takes its
 * own accept down with it, rather than adding a second reveal.
 */
async function createContactRevealEvent(
  tx: Prisma.TransactionClient,
  event: {
    requestId: string;
    offerId: string;
    providerId: string;
    customerUserId: string | null;
    revealedAt: Date;
    disclosureVersion: string;
  },
) {
  try {
    await tx.contactRevealEvent.create({ data: event });
  } catch (error) {
    // A unique violation means somebody already revealed this request or this
    // offer. Reported as the business rule it is, so the caller sees a 409
    // instead of a leaked Prisma error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'CONTACT_REVEAL_ALREADY_EXISTS',
        message: 'Bu talep için iletişim paylaşımı zaten kayıtlı.',
      });
    }

    throw error;
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

/**
 * Whether this caller opening this offer counts as *the customer* seeing it.
 *
 * Narrower than {@link ensureCustomerCanAccessRequest} on purpose. That guard
 * answers "may this request be read at all" and admits a SUPER_ADMIN so support
 * can look; this one answers "did the customer look", which is the fact the
 * refund policy turns on. A provider, an admin and any other role are reads, not
 * views.
 *
 * A request with no linked account is opened through its own link and has no
 * signed-in owner to compare against, so the link-holder is the customer — but
 * only while they are anonymous or signed in as a customer. An admin following
 * the same link is still an admin.
 */
function isCustomerViewer(customerId: string | null, user: AuthUser | null): boolean {
  if (customerId) {
    return user?.role === UserRole.CUSTOMER && user.id === customerId;
  }

  return user === null || user.role === UserRole.CUSTOMER;
}

function withRefundEligibility<T extends RefundPolicyOfferShape>(offer: T) {
  return {
    ...offer,
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
  // Required, not optional: every projection that renders a refund verdict has
  // to state whether the offer is inside the policy, and a caller that forgot
  // the column should fail to compile rather than quietly report an offer as
  // out of scope.
  unviewedRefundPolicy: boolean;
  entitlementSource?: OfferEntitlementSource | null;
};

/**
 * Gives one offer's credit back, inside the caller's transaction.
 *
 * Three things happen together or not at all: the OFFER_REFUND ledger row, the
 * offer's refund columns, and — because the caller holds the transaction — the
 * decision that led here. There is no window in which a provider's balance has
 * moved but the offer does not say so, or the reverse.
 *
 * Paying twice is prevented three times over, which for money is the right
 * number:
 *
 *  1. The conditional UPDATE below matches only an offer that is still unviewed
 *     and still unrefunded, so a customer who opens the offer between the
 *     worker's read and its write takes the refund away rather than racing it.
 *  2. The caller runs Serializable, so two workers cannot both observe an
 *     unrefunded offer.
 *  3. `ProviderCreditTransaction_one_refund_per_offer` — a partial UNIQUE index
 *     on ("referenceId") WHERE type = 'OFFER_REFUND' — makes a second refund row
 *     for one offer impossible in the database itself. This is the guarantee
 *     that does not depend on any code above it being right, and it is reported
 *     as the 409 it is rather than leaking a Prisma error.
 *
 * `storedReason` is written verbatim into the ledger and onto the offer. The
 * automatic path passes {@link UNVIEWED_OFFER_REFUND_REASON} and nothing else,
 * so the admin ledger shows exactly `UNVIEWED_OFFER_48H`.
 */
export async function refundOfferCreditInTransaction(
  tx: Prisma.TransactionClient,
  offer: {
    id: string;
    providerId: string;
    creditCost: number;
  },
  storedReason: string,
) {
  const currentBalance = await getProviderCreditBalanceInTransaction(tx, offer.providerId);
  const refundTransaction = await createRefundLedgerRow(tx, {
    providerId: offer.providerId,
    offerId: offer.id,
    creditCost: offer.creditCost,
    balanceAfter: currentBalance + offer.creditCost,
    storedReason,
  });

  const updated = await tx.offer.updateMany({
    where: {
      id: offer.id,
      // The eligibility rules, restated as a WHERE clause so they are re-checked
      // against the committed row and not against whatever the caller read a
      // moment ago. Status is deliberately absent: under this policy an
      // unviewed offer is refundable however it ended.
      unviewedRefundPolicy: true,
      viewedAt: null,
      creditRefundedTransactionId: null,
      creditRefundedAt: null,
      creditSpentTransactionId: { not: null },
      creditCost: { gt: 0 },
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

async function createRefundLedgerRow(
  tx: Prisma.TransactionClient,
  entry: {
    providerId: string;
    offerId: string;
    creditCost: number;
    balanceAfter: number;
    storedReason: string;
  },
) {
  try {
    return await tx.providerCreditTransaction.create({
      data: {
        providerId: entry.providerId,
        type: CreditTransactionType.OFFER_REFUND,
        amount: entry.creditCost,
        balanceAfter: entry.balanceAfter,
        reason: entry.storedReason,
        referenceType: 'Offer',
        referenceId: entry.offerId,
      },
    });
  } catch (error) {
    // The partial unique index fired: this offer already has a refund row. The
    // insert failed, so nothing was paid — the caller gets the same 409 the
    // application-level guards produce, and the transaction rolls back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Offer credit already refunded');
    }

    throw error;
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

/**
 * The customer's view of an offer.
 *
 * It deliberately carries no `refundEligibility`. Under the 48-hour policy that
 * verdict says, in effect, "leave this unopened and the provider gets their
 * credit back" — a reason for a customer not to look at an offer, published on
 * the very screen where they are meant to look at it. The provider is told the
 * policy because it is their money; the customer is not, because it is not
 * their decision to make.
 */
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
