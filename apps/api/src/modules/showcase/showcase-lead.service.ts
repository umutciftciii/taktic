import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ProviderStatus,
  ServiceRequestStatus,
  ShowcaseCardKind,
  ShowcaseCardStatus,
  ShowcaseLeadCloseReason,
  ShowcaseLeadFallbackDecision,
  ShowcaseLeadStatus,
  ShowcaseLeadUrgency,
  ShowcasePlacementStatus,
  ShowcaseVersionReview,
  UserRole,
} from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { runSerializable } from '../../common/serializable-transaction';
import { showcaseCandidateAreaKeys } from '../../common/showcase-area-key';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { normalizePhoneNumber } from '../phone-verification/phone.util';
import { resolveArea } from '../locations/turkey-locations';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { MarketplacePublishSettingsService } from '../operations-settings/marketplace-publish-settings.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import {
  CreateShowcaseLeadDto,
  ShowcaseFallbackDecisionDto,
} from './dto/showcase-lead.dto';
import {
  SHOWCASE_LEAD_DEDUPE_WINDOW_MINUTES,
  SHOWCASE_LEAD_RATE_LIMIT_PER_IP,
  SHOWCASE_LEAD_RATE_LIMIT_PER_PHONE,
  SHOWCASE_LEAD_RATE_LIMIT_WINDOW_MINUTES,
} from './showcase.constants';
import {
  showcaseAreaUnknown,
  showcaseCardNotFound,
  showcaseFallbackAlreadyDecided,
  showcaseLeadAreaNotServed,
  showcaseFallbackNotAvailable,
  showcaseLeadNotFound,
  showcaseLeadPhoneVerificationRequired,
  showcaseLeadRateLimited,
} from './showcase.errors';

/** How long a consumed verification stays redeemable. */
const VERIFICATION_REDEMPTION_WINDOW_MINUTES = 30;

export type LeadRequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * The direct vitrin lead: a request that reaches exactly one business, with a
 * clock on it.
 *
 * ## What a direct lead is, and is not
 *
 * It is an ordinary `ServiceRequest`. It goes through the same router walk, the
 * same question validation, the same quality score and the same contact rules,
 * because it is the same thing a customer would have submitted through the
 * public form — they just submitted it from a card instead. What makes it a
 * lead is two columns on that row and a `ShowcaseLead` beside it.
 *
 * It is **not** a marketplace request with a preference attached. Four things
 * that happen to every ordinary approved request do not happen here:
 *
 * - no matching, and no fan-out — `RequestPublishOutbox.enqueue` is never
 *   reached, and refuses a gated request if it ever were;
 * - no other provider can see it, at any point, until the customer says so;
 * - no offer credit is charged to the card's owner, because they already paid
 *   for the placement it arrived through;
 * - and the request does not wait in the moderation queue to reach the business
 *   it was addressed to.
 *
 * ## The three consequences of starting at SUBMITTED, and how each is answered
 *
 * The request is created SUBMITTED rather than APPROVED, because nobody has
 * read it. That has three knock-on effects and every one of them is handled
 * somewhere:
 *
 * 1. **Offers need an APPROVED request.** `acceptRequestOffer` is the most
 *    race-sensitive guard in the product and it is not widened. Instead, the
 *    card owner's offer moves the request to APPROVED in the same transaction —
 *    the card is already approved and the provider has just treated the lead as
 *    real, which is exactly what an approval asserts. The useful side effect is
 *    that `approvedAt` gets written, so the request joins the ordinary
 *    fourteen-day expiry and reminder machinery.
 * 2. **An unanswered lead would hang at SUBMITTED forever**, because the expiry
 *    sweeper only reads APPROVED rows. The SLA sweeper's second arm closes that
 *    gap: a breached lead the customer never answers is closed fourteen days
 *    later, and the request is cancelled with it.
 * 3. **Unmoderated text reaches a business directly.** This is a real, accepted
 *    risk with three mitigations: the quality score is still computed and shown
 *    to the provider, an operator can refuse the request at any moment (which
 *    closes the lead), and this endpoint requires a verified telephone number
 *    and is rate limited per number and per address. The marketplace does not
 *    take that risk — a lead the customer later *releases* goes through ordinary
 *    moderation before any other business sees it.
 *
 * ## Phone verification is mandatory here, whatever the flag says
 *
 * Everywhere else, `REQUIRE_PHONE_VERIFICATION` decides. Here it does not, and
 * this is the one place in the product where that flag is not the whole answer.
 * Two reasons, and they compound: this is the only path to a provider's inbox
 * with no operator in between, and the request will have to become APPROVED for
 * the provider's own offer to land — a transition that already refuses an
 * unverified number. Opening the lead anyway would start a clock on something
 * that could never progress.
 */
@Injectable()
export class ShowcaseLeadService {
  private readonly logger = new Logger('ShowcaseLead');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ServiceRequestsService) private readonly requests: ServiceRequestsService,
    @Inject(PhoneVerificationService)
    private readonly phoneVerification: PhoneVerificationService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Opening a lead
  // ──────────────────────────────────────────────────────────────────────────

  async createLead(
    cardId: string,
    dto: CreateShowcaseLeadDto,
    user: AuthUser | null,
    meta: LeadRequestMeta,
    options: { draftToken?: string | null } = {},
  ) {
    if (user?.role === UserRole.PROVIDER) {
      throw new ForbiddenException('Providers cannot open vitrin leads');
    }

    const now = new Date();

    // Re-verified here rather than trusted from whatever the client was
    // rendering: the page may have been open for an hour, and a card that has
    // since expired, been suspended or lost its approval must not take a lead
    // and start a clock on a business that is no longer advertising.
    const live = await this.loadLivePlacement(cardId, now);
    if (!live) {
      throw showcaseCardNotFound();
    }

    /*
     * The address on the request, checked against the run's own shelf.
     *
     * **This is the one check that makes the home page safe to show without a
     * location.** A visitor now reads every live card, so the "Hizmet bölgesi"
     * line on a card is a statement, not a filter — and a statement on a client
     * is not an access rule. Nothing stops somebody opening a Kadıköy card and
     * typing an Erzurum address into the form, and the business on the other
     * end would get a lead with a clock on it for work they never sold.
     *
     * The rule is exactly the shelf's own: the three keys a real address can
     * match, compared against the placement's active shelf rows. Not
     * `areaCovers` over the card version's areas — the *shelf* is what is on
     * the air, it is what a narrowing edit and an operator's suspension both
     * write to, and checking anything else would let a lead through for an area
     * that has since come off.
     */
    await this.assertPlacementServesRequest(live.placementId, dto);

    /*
     * The number the proof is for: resolved by the same rule that decides the
     * request's stored contact, so a signed-in customer's lead is proved
     * against the account's number and a guest's against the one they typed.
     * Reading `dto.customerPhone` directly would refuse every signed-in
     * customer, whose body carries no contact fields at all.
     */
    const contact = await this.requests.resolveContactDetails(dto, user);
    const phone = normalizePhoneNumber(contact.customerPhone);
    await this.assertWithinRateLimits(phone, meta.ipAddress, now);

    // A double-submitted form is one lead, not two. Deliberately an application
    // rule with no unique index behind it — a genuine second request from the
    // same person to the same business is perfectly possible, and a constraint
    // would refuse something legitimate. Ten minutes is short enough that only
    // a re-submitted form falls inside it.
    const duplicate = await this.findRecentLead(live.placementId, phone, now);
    if (duplicate) {
      return { lead: await this.presentForCustomer(duplicate.id), created: false };
    }

    const slaHours =
      dto.urgencyBucket === ShowcaseLeadUrgency.URGENT
        ? live.responseSlaUrgentHours
        : live.responseSlaNormalHours;

    let leadId: string | null = null;

    const request = await this.requests.createServiceRequest(
      { ...dto },
      user,
      {
        directShowcaseProviderId: live.providerId,
        // Filled by the hook below once the verification has actually been
        // redeemed inside the transaction. Set here as the value the request
        // row carries.
        phoneVerifiedAt: now,
        draftToken: options.draftToken ?? null,
        draftCardId: live.cardId,
        onCreated: async (tx, created) => {
          /*
           * The proof, redeemed inside the same transaction that creates the
           * request.
           *
           * Binding the verification row to the request is what makes one code
           * buy one lead: a second submission finds no unbound row for this
           * number and is refused. No token, no extra table, and nothing to
           * leak — the receipt is the row itself.
           *
           * Unless the account already holds the proof of this very number
           * (`User.phoneVerifiedAt`, checked by the request path under this
           * same transaction): then there is no standalone code to redeem,
           * and the request was born proven exactly as an ordinary one is.
           */
          if (!created.inheritedPhoneProof) {
            const verification = await this.phoneVerification.findRedeemableVerification(
              tx,
              phone,
              now,
              VERIFICATION_REDEMPTION_WINDOW_MINUTES,
            );

            if (!verification) {
              throw showcaseLeadPhoneVerificationRequired();
            }

            const bound = await tx.phoneVerification.updateMany({
              where: { id: verification.id, requestId: null },
              data: { requestId: created.id },
            });

            if (bound.count !== 1) {
              // Two submissions raced for one proof. The loser is refused rather
              // than granted a lead nothing verified.
              throw showcaseLeadPhoneVerificationRequired();
            }
          }

          const lead = await tx.showcaseLead.create({
            data: {
              requestId: created.id,
              placementId: live.placementId,
              cardId: live.cardId,
              cardVersionId: live.versionId,
              kindSnapshot: live.kind,
              // The price the customer actually read. NULL on a promotion card,
              // and a CHECK enforces both halves.
              listedPriceSnapshot:
                live.kind === ShowcaseCardKind.SERVICE ? live.listedServicePriceAmount : null,
              providerId: live.providerId,
              urgencyBucket: dto.urgencyBucket,
              // Read from the pinned version, never from the body: this is the
              // promise the provider made and an operator approved.
              slaHoursSnapshot: slaHours,
              // From `createdAt`, because a direct lead waits for nobody. The
              // card is already approved, so there is no moderation step whose
              // completion the clock could sensibly start from.
              slaDueAt: new Date(now.getTime() + slaHours * 60 * 60 * 1000),
              status: ShowcaseLeadStatus.OPEN,
              createdAt: now,
            },
            select: { id: true },
          });

          await tx.serviceRequest.update({
            where: { id: created.id },
            data: { showcaseLeadId: lead.id },
          });

          leadId = lead.id;
        },
      },
    );

    if (!leadId) {
      // Unreachable: the hook either wrote a lead or threw, and a throw rolls
      // the whole creation back.
      throw showcaseCardNotFound();
    }

    /*
     * One message, to one business.
     *
     * The approval fan-out (`RequestPublishOutbox`) is deliberately not booked
     * and never will be for a request whose gate is set: this lead is
     * addressed to one card owner,
     * and the whole promise of a placement is that it is not shared out.
     *
     * After the commit and best-effort, exactly as every other notification in
     * this codebase: the lead exists, the clock is running, and a mail
     * transport problem must not surface as a failed submission.
     */
    await this.notify(() => this.mail.sendShowcaseLeadReceived(leadId as string));

    this.logger.log(
      `vitrin lead ${leadId} opened on placement ${live.placementId} ` +
        `(${dto.urgencyBucket.toLowerCase()}, ${slaHours}h)`,
    );

    void request;
    return { lead: await this.presentForCustomer(leadId), created: true };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // The provider's inbox
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * The card owner's leads, and nobody else's.
   *
   * A separate list from `GET /providers/:id/requests` for one structural
   * reason: these requests are `SUBMITTED`, and the discovery list reads
   * `APPROVED` because that is what moderation means for everything else. A
   * direct lead has no moderation step before it reaches its addressee, so it
   * would be invisible in that list right up until the provider answered it.
   */
  async listForProvider(providerId: string, status?: ShowcaseLeadStatus) {
    const leads = await this.prisma.showcaseLead.findMany({
      where: { providerId, ...(status ? { status } : {}) },
      orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'desc' }],
      select: providerLeadSelect,
    });

    return { leads: leads.map(toProviderLead) };
  }

  async getForProvider(providerId: string, leadId: string) {
    const lead = await this.prisma.showcaseLead.findFirst({
      // The provider id is in the `where`, not checked afterwards: another
      // business's lead is a 404 with the same body as an id that names
      // nothing, exactly as a card is.
      where: { id: leadId, providerId },
      select: providerLeadSelect,
    });

    if (!lead) {
      throw showcaseLeadNotFound();
    }

    return toProviderLead(lead);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // The customer's decision after a breach
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * `RELEASE` or `KEEP_CLOSED`, and the whole of what a missed deadline is
   * allowed to lead to.
   *
   * **A breach on its own opens nothing.** The customer wrote to one business;
   * handing their request to every business in the district because that one
   * was slow is a decision only they can make. The database says the same
   * thing from the other side — `ShowcaseLead_release_needs_decision` refuses a
   * `releasedAt` that is not accompanied by this customer's RELEASE.
   *
   * `RELEASE` always clears the gate; what happens next depends on the
   * marketplace auto-publish switch. Off, the request is left `SUBMITTED`,
   * which puts it in the **ordinary moderation queue** — the answer to the one
   * real cost of skipping moderation on the way in: unread text reached one
   * business that chose to advertise, and it does not reach the market until an
   * operator has read it. When it is later approved, the publish outbox fans it
   * out exactly as it does for any other request. On, there is nobody left to
   * moderate it: the customer's RELEASE **is** the publish decision, so the
   * same transaction that clears the gate calls
   * `ServiceRequestsService.publishRequestInTransaction` and books the same
   * fan-out immediately — there is no special case either way, because by then
   * there is nothing special about the request.
   *
   * `KEEP_CLOSED` cancels the request through the existing cancellation path.
   * The gate stays set, which is deliberate: the record of who this was
   * addressed to survives the closure.
   */
  async decideFallback(
    requestId: string,
    user: AuthUser,
    dto: ShowcaseFallbackDecisionDto,
  ) {
    const now = new Date();
    // Read once, outside the transaction — the same value has to decide both
    // whether this call publishes and whether it owes a delivery sweep
    // afterwards.
    const autoPublish = await this.publishSettings.isAutoPublishEnabled();

    const outcome = await runSerializable(
      this.prisma,
      async (tx) => {
        const request = await tx.serviceRequest.findUnique({
          where: { id: requestId },
          select: {
            id: true,
            status: true,
            customerId: true,
            showcaseLeadId: true,
          },
        });

        // The same 404 for "no such request", "not yours" and "not a vitrin
        // lead". A customer probing request ids must not learn which ones are
        // real, and a distinguishable answer here would be exactly that.
        if (!request || !request.showcaseLeadId) {
          throw showcaseLeadNotFound();
        }

        if (
          user.role !== UserRole.SUPER_ADMIN &&
          (user.role !== UserRole.CUSTOMER ||
            !request.customerId ||
            request.customerId !== user.id)
        ) {
          throw showcaseLeadNotFound();
        }

        const lead = await tx.showcaseLead.findUnique({
          where: { id: request.showcaseLeadId },
          select: { id: true, status: true, fallbackDecidedAt: true },
        });

        if (!lead) {
          throw showcaseLeadNotFound();
        }

        if (lead.fallbackDecidedAt) {
          throw showcaseFallbackAlreadyDecided();
        }

        if (lead.status !== ShowcaseLeadStatus.BREACHED) {
          throw showcaseFallbackNotAvailable();
        }

        if (dto.decision === ShowcaseLeadFallbackDecision.RELEASE) {
          // Conditional on everything that has to still be true, so a second
          // submission and a concurrent sweeper both find nothing to change.
          const moved = await tx.showcaseLead.updateMany({
            where: {
              id: lead.id,
              status: ShowcaseLeadStatus.BREACHED,
              fallbackDecidedAt: null,
            },
            data: {
              status: ShowcaseLeadStatus.RELEASED,
              fallbackDecision: ShowcaseLeadFallbackDecision.RELEASE,
              fallbackDecidedAt: now,
              releasedAt: now,
            },
          });

          if (moved.count !== 1) {
            throw showcaseFallbackAlreadyDecided();
          }

          // The gate comes down. From this moment the request is an ordinary
          // one in every respect — including that the card's own owner now pays
          // the ordinary credit price to offer on it.
          await tx.serviceRequest.update({
            where: { id: requestId },
            data: { directShowcaseProviderId: null },
          });

          // The market's reason to wait — "unread text must pass an operator
          // first" — no longer exists when auto-publish is on: the release is
          // the customer's decision and the request goes live right here.
          const published =
            autoPublish && (await this.requests.publishRequestInTransaction(tx, requestId, now));

          return { decision: 'RELEASE' as const, leadId: lead.id, published };
        }

        const moved = await tx.showcaseLead.updateMany({
          where: {
            id: lead.id,
            status: ShowcaseLeadStatus.BREACHED,
            fallbackDecidedAt: null,
          },
          data: {
            status: ShowcaseLeadStatus.CLOSED_UNANSWERED,
            fallbackDecision: ShowcaseLeadFallbackDecision.KEEP_CLOSED,
            fallbackDecidedAt: now,
            closedAt: now,
            closeReason: ShowcaseLeadCloseReason.CUSTOMER_KEPT_CLOSED,
          },
        });

        if (moved.count !== 1) {
          throw showcaseFallbackAlreadyDecided();
        }

        // Cancelled through the ordinary terminal transition rather than a
        // vitrin-specific one, so every screen that already understands a
        // cancelled request understands this.
        await tx.serviceRequest.updateMany({
          where: { id: requestId, status: { in: [ServiceRequestStatus.SUBMITTED] } },
          data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: now },
        });

        return { decision: 'KEEP_CLOSED' as const, leadId: lead.id };
      },
      { label: 'showcase.decideFallback' },
    );

    if (outcome.decision === 'RELEASE' && outcome.published) {
      this.publishOutbox.deliverSoon();
    }

    return this.presentForCustomer(outcome.leadId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * The card's live placement, resolved on the server from the card id alone.
   *
   * **The body never names a placement**, and this method is why. The lead
   * endpoint needs no session, so a client that could supply a placement id
   * could attach its lead — and the clock that comes with it — to a run
   * somebody else paid for. Resolving it here makes that unrepresentable rather
   * than merely refused.
   *
   * The predicate is the same full one the feed uses, joins included: the card
   * approved, the pinned version approved, the provider approved, and the run
   * inside its own window. A card the visitor's browser is still rendering from
   * a cached page must not be able to take a lead.
   */
  /**
   * Whether this run is actually on the air for the address the customer typed.
   *
   * The city/district/neighbourhood triple is re-resolved against the shipped
   * location list first, for the same reason every other public write does it:
   * "KADIKÖY", "Kadıköy" and "kadikoy" have to fold to one place before they can
   * be compared with a key, and a triple that names no real place is a bad
   * request rather than a silent miss. `createServiceRequest` will refuse the
   * same triple a moment later — this only has to get there first, so the
   * customer is told the useful thing ("this card does not cover you, here is
   * the ordinary route") rather than a generic location error.
   */
  private async assertPlacementServesRequest(
    placementId: string,
    dto: CreateShowcaseLeadDto,
  ): Promise<void> {
    const area = resolveArea({
      city: dto.city?.trim() ?? '',
      district: dto.district?.trim() || null,
      neighborhood: dto.neighborhood?.trim() || null,
    });

    if (!area) {
      throw showcaseAreaUnknown();
    }

    const served = await this.prisma.showcasePlacementShelf.findFirst({
      where: {
        placementId,
        active: true,
        areaKey: { in: showcaseCandidateAreaKeys(area) },
      },
      select: { id: true },
    });

    if (!served) {
      throw showcaseLeadAreaNotServed();
    }
  }

  private async loadLivePlacement(cardId: string, now: Date) {
    const placement = await this.prisma.showcasePlacement.findFirst({
      where: {
        cardId,
        status: ShowcasePlacementStatus.ACTIVE,
        startAt: { lte: now },
        endAt: { gt: now },
        card: { status: ShowcaseCardStatus.APPROVED },
        pinnedVersion: { reviewStatus: ShowcaseVersionReview.APPROVED },
        provider: { status: ProviderStatus.APPROVED },
      },
      select: {
        id: true,
        cardId: true,
        providerId: true,
        kindSnapshot: true,
        pinnedVersion: {
          select: {
            id: true,
            responseSlaUrgentHours: true,
            responseSlaNormalHours: true,
            listedServicePriceAmount: true,
          },
        },
      },
    });

    if (!placement) {
      return null;
    }

    return {
      placementId: placement.id,
      cardId: placement.cardId,
      providerId: placement.providerId,
      kind: placement.kindSnapshot,
      versionId: placement.pinnedVersion.id,
      responseSlaUrgentHours: placement.pinnedVersion.responseSlaUrgentHours,
      responseSlaNormalHours: placement.pinnedVersion.responseSlaNormalHours,
      listedServicePriceAmount: placement.pinnedVersion.listedServicePriceAmount,
    };
  }

  /**
   * Two counters, on the same window, answering two different abuses.
   *
   * The per-number budget stops one verified person opening twenty leads on
   * twenty cards in a minute. The per-address budget stops a script cycling
   * through numbers. Neither is generous, because a genuine customer writing to
   * three businesses in an hour is well inside both.
   *
   * One refusal for both, saying nothing about which was hit or how much is
   * left: a rate limit that reports its own state is one that can be measured.
   */
  private async assertWithinRateLimits(
    normalizedPhone: string,
    ipAddress: string | null,
    now: Date,
  ) {
    const since = new Date(
      now.getTime() - SHOWCASE_LEAD_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    );

    /*
     * Both counters are matched through the verification each lead redeemed,
     * never through `ServiceRequest.customerPhone`.
     *
     * That column holds what the customer typed, lightly cleaned — "0555 111 22
     * 33" stays a local number — while a rate limit has to compare *numbers*
     * rather than spellings, or one person writes to five businesses in five
     * different formats and the budget never fires. `PhoneVerification` already
     * stores the canonical E.164 form for exactly this reason, and every direct
     * lead has one bound to it by construction.
     *
     * The address comes off the same row, because that is where this
     * application already records it: the lead itself stores no address, and
     * adding one would widen what this table holds for no gain.
     */
    const byPhone = await this.prisma.showcaseLead.count({
      where: {
        createdAt: { gte: since },
        request: { phoneVerifications: { some: { normalizedPhone } } },
      },
    });

    if (byPhone >= SHOWCASE_LEAD_RATE_LIMIT_PER_PHONE) {
      throw showcaseLeadRateLimited();
    }

    if (!ipAddress) {
      return;
    }

    const byIp = await this.prisma.showcaseLead.count({
      where: {
        createdAt: { gte: since },
        request: { phoneVerifications: { some: { ipAddress } } },
      },
    });

    if (byIp >= SHOWCASE_LEAD_RATE_LIMIT_PER_IP) {
      throw showcaseLeadRateLimited();
    }
  }

  /** Matched on the canonical number, for the reason the rate limits are. */
  private findRecentLead(placementId: string, normalizedPhone: string, now: Date) {
    const since = new Date(now.getTime() - SHOWCASE_LEAD_DEDUPE_WINDOW_MINUTES * 60 * 1000);

    return this.prisma.showcaseLead.findFirst({
      where: {
        placementId,
        status: ShowcaseLeadStatus.OPEN,
        createdAt: { gte: since },
        request: { phoneVerifications: { some: { normalizedPhone } } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
  }

  /**
   * What the customer's own screen is told about their lead.
   *
   * The provider block is the business they wrote to, which they already know.
   * Nothing about the placement travels: not its id, not what it cost, not when
   * it ends.
   */
  private async presentForCustomer(leadId: string) {
    const lead = await this.prisma.showcaseLead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        id: true,
        status: true,
        urgencyBucket: true,
        slaHoursSnapshot: true,
        slaDueAt: true,
        breachedAt: true,
        fallbackAskedAt: true,
        fallbackDecision: true,
        fallbackDecidedAt: true,
        releasedAt: true,
        closedAt: true,
        closeReason: true,
        createdAt: true,
        kindSnapshot: true,
        listedPriceSnapshot: true,
        request: { select: { id: true, requestNumber: true, status: true } },
        cardVersion: { select: { title: true } },
        provider: { select: { id: true, businessName: true } },
      },
    });

    return {
      id: lead.id,
      status: lead.status,
      urgencyBucket: lead.urgencyBucket,
      slaHours: lead.slaHoursSnapshot,
      slaDueAt: lead.slaDueAt,
      breachedAt: lead.breachedAt,
      fallbackAskedAt: lead.fallbackAskedAt,
      fallbackDecision: lead.fallbackDecision,
      fallbackDecidedAt: lead.fallbackDecidedAt,
      releasedAt: lead.releasedAt,
      closedAt: lead.closedAt,
      closeReason: lead.closeReason,
      createdAt: lead.createdAt,
      cardTitle: lead.cardVersion.title,
      kind: lead.kindSnapshot,
      ...(lead.kindSnapshot === ShowcaseCardKind.SERVICE
        ? { listedServicePriceAmount: lead.listedPriceSnapshot }
        : {}),
      request: lead.request,
      provider: lead.provider,
    };
  }

  private async notify(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        'vitrin lead notification failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * What the card's owner sees about a lead they have not been paid to see
 * — which is to say, everything about the job and nothing about the person
 * until an offer is accepted.
 *
 * `customerPhone` and `customerEmail` are **not** selected. Contact details open
 * through `ContactRevealEvent` and through nothing else, and a direct lead is
 * not an exception to that rule: the provider answers with an offer, the
 * customer accepts it, and the reveal happens on the existing path. The masked
 * name is what a provider needs to write a sensible message.
 */
const providerLeadSelect = {
  id: true,
  status: true,
  urgencyBucket: true,
  slaHoursSnapshot: true,
  slaDueAt: true,
  breachedAt: true,
  respondedAt: true,
  respondedOfferId: true,
  closedAt: true,
  closeReason: true,
  createdAt: true,
  kindSnapshot: true,
  listedPriceSnapshot: true,
  cardId: true,
  cardVersion: { select: { id: true, title: true, versionNumber: true } },
  request: {
    select: {
      id: true,
      requestNumber: true,
      status: true,
      categoryId: true,
      category: { select: { id: true, name: true, slug: true, offerCreditCost: true } },
      city: true,
      district: true,
      neighborhood: true,
      description: true,
      urgency: true,
      preferredDate: true,
      preferredDateEnd: true,
      budgetMin: true,
      budgetMax: true,
      qualityScore: true,
      customerName: true,
      submittedAt: true,
      answers: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, questionKey: true, questionLabel: true, questionType: true, value: true },
      },
    },
  },
} satisfies Prisma.ShowcaseLeadSelect;

type ProviderLeadRow = Prisma.ShowcaseLeadGetPayload<{ select: typeof providerLeadSelect }>;

function toProviderLead(lead: ProviderLeadRow) {
  return {
    id: lead.id,
    status: lead.status,
    urgencyBucket: lead.urgencyBucket,
    slaHours: lead.slaHoursSnapshot,
    slaDueAt: lead.slaDueAt,
    breachedAt: lead.breachedAt,
    respondedAt: lead.respondedAt,
    respondedOfferId: lead.respondedOfferId,
    closedAt: lead.closedAt,
    closeReason: lead.closeReason,
    createdAt: lead.createdAt,
    card: { id: lead.cardId, versionId: lead.cardVersion.id, title: lead.cardVersion.title },
    kind: lead.kindSnapshot,
    ...(lead.kindSnapshot === ShowcaseCardKind.SERVICE
      ? { listedServicePriceAmount: lead.listedPriceSnapshot }
      : {}),
    request: lead.request,
  };
}
