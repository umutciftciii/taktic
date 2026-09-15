import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { assertNoContactDetails, CONTACT_DETAILS_IN_TEXT_CODE } from '../../common/contact-guard';
import { isPhoneVerificationRequired } from '../phone-verification/phone-verification.constants';
import { CustomerOrigin, NumberedEntityType, OfferEntitlementSource, OfferStatus, Prisma, QuestionConditionMatchMode, ServiceRequestQuestion, ServiceRequestQuestionType, ServiceRequestReportResolution, ServiceRequestStatus, ShowcaseLeadCloseReason, UserRole } from '@prisma/client';
import { runSerializable } from '../../common/serializable-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  CONTACT_DISCLOSURE_REQUIRED_CODE,
  readContactSharingConfig,
} from '../contact-sharing/contact-sharing.config';
import { CategoriesService, RoutingResolution } from '../categories/categories.service';
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { RequestPublishOutbox } from '../notifications/request-publish-outbox.service';
import { ReviewInvitationOutbox } from '../notifications/review-invitation-outbox.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { MarketplacePublishSettingsService } from '../operations-settings/marketplace-publish-settings.service';
import { resolveLocation } from '../locations/turkey-locations';
import { NumberingService } from '../numbering/numbering.service';
import { refundOfferCreditInTransaction } from '../offers/offers.service';
import { REQUEST_REMOVED_REFUND_REASON } from '../offers/refund-policy';
import { resolveVisibleQuestionIds } from '../questions/question-visibility';
import { ShowcaseLeadLifecycleService } from '../showcase/showcase-lead-lifecycle.service';
import { RequestDraftsService } from '../request-drafts/request-drafts.service';
import {
  hasSystemFieldValue,
  SystemFieldRequestValues,
  systemFieldLabel,
} from '../questions/question-system-fields';
import {
  SERVICE_REQUEST_MAX_OPEN_PER_PHONE,
  SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY,
} from './service-requests.constants';
import { CreateServiceRequestAnswerDto, CreateServiceRequestDto } from './dto/create-service-request.dto';
import { UpdateServiceRequestStatusDto } from './dto/update-service-request-status.dto';

/**
 * Returned when a signed-in customer's own account carries no complete contact
 * triple, so the default "use my account details" path has nothing to use.
 *
 * A code rather than a message match: the web form reads it to explain what is
 * missing instead of showing a raw validation error.
 */
export const ACCOUNT_CONTACT_INCOMPLETE_CODE = 'ACCOUNT_CONTACT_INCOMPLETE';

/**
 * Returned when a request creation is refused because the provided phone and
 * email belong to two different customers.
 */
export const CUSTOMER_IDENTITY_CONFLICT_CODE = 'CUSTOMER_IDENTITY_CONFLICT';

type QuestionOption = {
  key: string;
  label: string;
};

/**
 * A question with everything answer validation needs: the question row itself
 * plus the visibility rules that decide whether it was ever on screen.
 */
type QuestionForValidation = ServiceRequestQuestion & {
  conditions: {
    sourceQuestionId: string;
    expectedValues: string[];
    matchMode: QuestionConditionMatchMode;
  }[];
};

type ValidatedAnswer = {
  questionId: string;
  questionKey: string;
  questionLabel: string;
  questionType: string;
  value: Prisma.InputJsonValue;
};

type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

type QualityComponent = {
  points: number;
  max: number;
  passed: boolean;
};

type QualityBreakdown = Record<string, QualityComponent>;

type QualityScoringInput = {
  customerName: string;
  customerPhone: string;
  city: string;
  district: string;
  neighborhood: string | null;
  addressNote: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDate: Date | string | null;
  urgency: string | null;
  description: string | null;
  questions: Pick<ServiceRequestQuestion, 'id' | 'isRequired'>[];
  answers: { questionId: string; value: unknown }[];
};

/**
 * What a caller other than the public form needs to add to a request.
 *
 * Only the vitrin lead path passes one, and everything in it is about the same
 * single fact: this request came from one business's card and, for now, belongs
 * to that business alone.
 *
 * `onCreated` runs inside the creation transaction. That is the point of it —
 * the lead row, the SLA it freezes and the verification it redeems all have to
 * commit with the request or not at all.
 */
export type ServiceRequestCreationContext = {
  /** The one provider allowed to see this request. */
  directShowcaseProviderId?: string;
  /**
   * When the customer proved control of the number, established *before* the
   * request existed. See `PhoneVerificationService.sendStandaloneCode`.
   */
  phoneVerifiedAt?: Date;
  /**
   * The draft token the browser carried (see RequestDraftsService). Consumed
   * inside the creation transaction so "the request exists" and "the draft is
   * used up" are one fact; a draft protected for another account is skipped.
   */
  draftToken?: string | null;
  /** The card id a vitrin draft was keyed on. Absent on the public form. */
  draftCardId?: string | null;
  onCreated?: (
    tx: Prisma.TransactionClient,
    request: { id: string; customerId: string | null },
  ) => Promise<void>;
};

const moderatedStatuses = new Set<ServiceRequestStatus>([
  ServiceRequestStatus.IN_REVIEW,
  ServiceRequestStatus.APPROVED,
  ServiceRequestStatus.REJECTED,
]);

/**
 * Lifecycle states the moderation endpoint must never write.
 *
 * MATCHED belongs to the offer-accept cascade, EXPIRED to the expiry scheduler,
 * and COMPLETED to the dedicated lifecycle endpoint — each of them writes
 * timestamps and runs invariants the moderation dropdown knows nothing about.
 */
const nonModerationStatuses = new Set<ServiceRequestStatus>([
  ServiceRequestStatus.MATCHED,
  ServiceRequestStatus.COMPLETED,
  ServiceRequestStatus.EXPIRED,
]);

/**
 * Whether a moderation save is the one that takes a marketplace request live:
 * a move *into* APPROVED (not a re-save of it) on a request no single vitrin
 * business holds.
 */
function isPublishingTransition(
  from: ServiceRequestStatus,
  to: ServiceRequestStatus,
  directShowcaseProviderId: string | null,
): boolean {
  return (
    to === ServiceRequestStatus.APPROVED &&
    from !== ServiceRequestStatus.APPROVED &&
    directShowcaseProviderId === null
  );
}

/** A request in one of these states has finished; nothing may move it again. */
const terminalStatuses = new Set<ServiceRequestStatus>([
  ServiceRequestStatus.COMPLETED,
  ServiceRequestStatus.CANCELLED,
  ServiceRequestStatus.EXPIRED,
  ServiceRequestStatus.REJECTED,
]);

@Injectable()
export class ServiceRequestsService {
  private readonly logger = new Logger(ServiceRequestsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CustomerActivationService)
    private readonly customerActivation: CustomerActivationService,
    @Inject(TransactionalMailService) private readonly mail: TransactionalMailService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ShowcaseLeadLifecycleService)
    private readonly showcaseLeads: ShowcaseLeadLifecycleService,
    @Inject(RequestDraftsService) private readonly drafts: RequestDraftsService,
    @Inject(MarketplacePublishSettingsService)
    private readonly publishSettings: MarketplacePublishSettingsService,
    @Inject(RequestPublishOutbox) private readonly publishOutbox: RequestPublishOutbox,
    @Inject(ReviewInvitationOutbox) private readonly reviewInvitations: ReviewInvitationOutbox,
  ) {}

  /**
   * Creates a request from the public form, or from a vitrin card.
   *
   * `context` is how the second one differs, and it is deliberately the only
   * difference. Everything else — routing, the category's own questions, the
   * answer validation, the quality score, the contact resolution and the
   * customer account behind a guest submission — is identical, because a direct
   * lead **is** an ordinary service request. What makes it a lead is a
   * visibility gate on the row and a `ShowcaseLead` beside it, not a different
   * kind of request.
   *
   * That is why this method was extended rather than copied. A second creation
   * path would be a second place for the quality score, the router walk and the
   * contact rules to be got right, and the first time they drifted apart the
   * lead would be the one with the bug.
   */
  async createServiceRequest(
    dto: CreateServiceRequestDto,
    user: AuthUser | null = null,
    context: ServiceRequestCreationContext = {},
  ) {
    if (user && user.role === UserRole.PROVIDER) {
      throw new ForbiddenException('Providers cannot create customer service requests');
    }

    const categorySlug = normalizeRequiredString(dto.categorySlug, 'Category slug');
    // The client posts the option keys it was shown; the API alone turns them
    // into a category. An unrouted request sends no selections and the walk
    // returns the entry category itself, which is exactly the behaviour every
    // client written before routing existed relies on.
    const routing = await this.categories.walkRouting(
      categorySlug,
      (dto.routerSelections ?? []).map((selection) => ({
        questionKey: normalizeRequiredString(selection.questionKey, 'Question key'),
        optionKey: normalizeRequiredString(selection.optionKey, 'Option key'),
      })),
      user?.role === UserRole.SUPER_ADMIN,
    );

    if (routing.pendingRouterQuestionKey !== null) {
      throw new BadRequestException(
        `Yönlendirme tamamlanmadı: ${routing.pendingRouterQuestionKey} sorusu yanıtlanmalı.`,
      );
    }

    const category = await this.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: routing.category.id },
      include: {
        questions: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
          include: {
            conditions: {
              select: { sourceQuestionId: true, expectedValues: true, matchMode: true },
            },
          },
        },
      },
    });

    const preferredDate = normalizeOptionalDate(dto.preferredDate, 'Preferred date');
    const disclosure = resolveContactDisclosure(dto);
    // The DTO already refused an impossible triple; this turns the accepted one
    // into the canonical spelling the rest of the product compares against —
    // provider service areas are matched on city and district as plain strings,
    // so "istanbul" and "İstanbul" must not become two different places.
    const location = resolveLocation({
      city: normalizeRequiredString(dto.city, 'City'),
      district: normalizeRequiredString(dto.district, 'District'),
      neighborhood: normalizeNullableString(dto.neighborhood),
    });

    if (!location) {
      throw new BadRequestException(
        'Seçilen il, ilçe ve mahalle birlikte geçerli bir adres oluşturmuyor.',
      );
    }

    // Who the offers will be shared with. For a signed-in customer on the
    // default path this reads the account row and nothing else — the body's own
    // contact fields are not consulted at all, so a forged one cannot become
    // the stored contact of a request that belongs to that account.
    const contact = await this.resolveContactDetails(dto, user);

    const requestData = {
      ...contact,
      city: location.city,
      district: location.district,
      neighborhood: location.neighborhood,
      addressNote: normalizeNullableString(dto.addressNote),
      ...normalizeBudgetRange(dto.budgetMin, dto.budgetMax),
      preferredDate,
      urgency: normalizeNullableString(dto.urgency),
      description: normalizeNullableString(dto.description),
    };

    // Refused before anything else touches these values: a request that
    // publishes straight to providers must not carry a way to reach the
    // customer off-platform in the two free-text fields it controls
    // directly. The vitrin lead path goes through this same method, so it is
    // covered without a second check.
    assertNoContactDetails('description', requestData.description);
    assertNoContactDetails('addressNote', requestData.addressNote);

    // Answers are validated after the request fields are normalised, because a
    // system-bound question is a rule *about* those fields: "this category
    // requires a neighbourhood", "this one requires a budget". The bound
    // question never produces an answer row — the value stays in the column
    // provider matching and pricing already read.
    const answers = validateAnswers(category.questions, dto.answers ?? [], requestData);

    const quality = calculateQualityScore({
      ...requestData,
      // System-bound questions are excluded: the fields they name — address,
      // budget, description, preferred date — are already scored by name in the
      // breakdown, and counting them again as unanswered questions would make a
      // category that binds them score lower for exactly the data it demands.
      questions: category.questions.filter((question) => question.systemField === null),
      answers,
    });

    // Read once per creation, outside the transaction: the switch is an
    // operations decision that changes rarely, and a request that raced a
    // toggle lands on whichever side it read — both sides are valid states.
    //
    // Three things have to agree for a request to be born live. The switch is
    // on; the request is a marketplace one (a vitrin lead is reserved for a
    // single business and is published by its own flow, never here); and the
    // number is either not gated or already proven. A gated, unproven request
    // waits at SUBMITTED for `PhoneVerificationService.verifyCode`, which
    // publishes it in the same transaction that stamps the proof — that is
    // the one case whose receipt tells the customer to verify rather than to
    // wait for an operator.
    const autoPublish =
      (await this.publishSettings.isAutoPublishEnabled()) && !context.directShowcaseProviderId;
    const awaitsVerification =
      autoPublish && isPhoneVerificationRequired() && !context.phoneVerifiedAt;
    const publishAtCreate = autoPublish && !awaitsVerification;
    const now = new Date();

    const request = await runSerializable(
      this.prisma,
      async (tx) => {
      // Per-phone budget, ahead of everything else in the transaction: a
      // customer (or an attacker cycling identities behind one number)
      // should not be able to spend the rest of this work — routing,
      // quality scoring, the customer row itself — only to be refused at the
      // very end. Counted by phone rather than by account because a guest
      // checkout has no account yet, and because the limit is about how many
      // requests one real phone number is allowed to have in flight,
      // regardless of which session created them.
      const phoneWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const [recentByPhone, openByPhone] = await Promise.all([
        tx.serviceRequest.count({
          where: {
            customerPhone: requestData.customerPhone,
            submittedAt: { gte: phoneWindowStart },
            status: { in: [ServiceRequestStatus.SUBMITTED, ServiceRequestStatus.APPROVED] },
          },
        }),
        tx.serviceRequest.count({
          where: { customerPhone: requestData.customerPhone, status: ServiceRequestStatus.APPROVED },
        }),
      ]);
      if (
        recentByPhone >= SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY ||
        openByPhone >= SERVICE_REQUEST_MAX_OPEN_PER_PHONE
      ) {
        throw new HttpException(
          {
            statusCode: 429,
            error: 'Too Many Requests',
            code: 'REQUEST_RATE_LIMITED',
            message:
              'Bu telefon numarasıyla kısa sürede çok fazla talep açıldı. Lütfen daha sonra tekrar deneyin.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const customerId = await resolveCustomerForCreate(tx, requestData, user);
      const requestNumber = await this.numbering.generateDisplayNumber(
        tx,
        NumberedEntityType.SERVICE_REQUEST,
      );

      const created = await tx.serviceRequest.create({
        data: {
          categoryId: category.id,
          // Only when routing actually moved the request. NULL keeps meaning
          // "the entry was the category", which is what every unrouted request
          // — past and present — carries.
          entryCategoryId:
            routing.entryCategory.id === category.id ? null : routing.entryCategory.id,
          customerId,
          requestNumber,
          // Born live when the operations switch says so. One INSERT, one state:
          // approvedAt is the same instant as submittedAt, and moderatedAt stays
          // NULL because no person approved this — that pair is how a row says
          // "auto-published" without a column for it.
          submittedAt: now,
          ...(publishAtCreate ? { status: ServiceRequestStatus.APPROVED, approvedAt: now } : {}),
          ...requestData,
          ...disclosure,
          // The visibility gate. NULL on every request from the public form,
          // which is what keeps the marketplace's behaviour exactly as it was:
          // an ordinary request goes to every matching provider, and nothing
          // about matching, fan-out or offer pricing reads this column when it
          // is null.
          ...(context.directShowcaseProviderId
            ? { directShowcaseProviderId: context.directShowcaseProviderId }
            : {}),
          // Written by the vitrin path in the same transaction, before anything
          // is committed: a lead reaches a business having already proved its
          // telephone number, because there is no operator in that flow to
          // catch what a false number would cost.
          ...(context.phoneVerifiedAt ? { phoneVerifiedAt: context.phoneVerifiedAt } : {}),
          qualityScore: quality.score,
          qualityScoreBreakdown: quality.breakdown,
          answers: {
            // The router steps are stored alongside the leaf's own answers.
            // They are real answers to real questions, and a provider pricing a
            // routed request needs to see the choice that put it in front of
            // them. Quality scoring above deliberately ignores them: it grades
            // how completely the customer filled in *this* category's form.
            create: [...routerAnswerRows(routing.routerAnswers), ...answers],
          },
        },
        include: {
          category: {
            select: { id: true, name: true, slug: true },
          },
          answers: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      // The draft the browser carried, consumed in the same transaction that
      // wrote the request: "the request exists" and "the draft is used up"
      // become one fact, and a draft protected for another account is
      // skipped rather than blocking this submission.
      await this.drafts.consumeInTransaction(
        tx,
        context.draftToken ?? null,
        {
          formType: context.directShowcaseProviderId ? 'SHOWCASE_LEAD' : 'MARKETPLACE',
          categorySlug,
          cardId: context.draftCardId ?? null,
        },
        created.customerId,
      );

      // The vitrin lead, its SLA and the verification it redeemed, all inside
      // the transaction that created the request. A request carrying a
      // `directShowcaseProviderId` with no lead beside it would be a request
      // one business can see and nobody can explain.
      if (context.onCreated) {
        await context.onCreated(tx, { id: created.id, customerId: created.customerId });
      }

      // The fan-out this publication owes, written down in the same
      // transaction: "the request is live" and "its notifications are owed"
      // commit together or not at all. Nothing is sent here.
      if (publishAtCreate) {
        await this.publishOutbox.enqueue(tx, created.id, now);
      }

      return created;
      },
      { label: 'serviceRequests.create' },
    );

    // A guest request creates a password-less customer account behind the
    // scenes. Mail them a claim link straight away, otherwise they can never
    // reach the offers on their own request.
    //
    // Best-effort on purpose: the request is already committed, so a
    // notification problem must not surface as a failed submission.
    if (request.customerId) {
      try {
        await this.customerActivation.issueForAutoCreatedCustomer(request.customerId);
      } catch (error) {
        this.logger.error(
          `Failed to issue activation link for request ${request.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (request.status === ServiceRequestStatus.APPROVED) {
      // Live already: the customer is told "yayında", not "alındı". The
      // intents are committed; delivery is fired and not awaited, so the
      // response never waits on a mail provider.
      this.publishOutbox.deliverSoon();
    } else {
      // The receipt for the request the visitor just submitted. After the
      // commit and best-effort, for the same reason the activation link above
      // is: the request exists, and a mail problem must not surface as a
      // failed submission. `nextStep` tells the customer what the request is
      // waiting for — their own verification, or an operator.
      await this.notify(
        () =>
          this.mail.sendRequestReceived(request.id, {
            nextStep: awaitsVerification ? 'verify' : 'review',
          }),
        request.id,
      );
    }

    return withQualityLabel(request);
  }

  /**
   * Moves a waiting marketplace request to APPROVED and books its fan-out, in
   * the caller's transaction. Conditional on SUBMITTED and on an open gate, so
   * two callers cannot both publish and a vitrin lead cannot be published by
   * anything but its own flow. Returns whether this call was the one.
   */
  async publishRequestInTransaction(
    tx: Prisma.TransactionClient,
    requestId: string,
    now: Date,
  ): Promise<boolean> {
    const moved = await tx.serviceRequest.updateMany({
      where: {
        id: requestId,
        status: ServiceRequestStatus.SUBMITTED,
        directShowcaseProviderId: null,
      },
      data: { status: ServiceRequestStatus.APPROVED, approvedAt: now },
    });

    if (moved.count !== 1) {
      return false;
    }

    await this.publishOutbox.enqueue(tx, requestId, now);
    return true;
  }

  /**
   * The name, telephone number and e-mail address the request is stored with.
   *
   * There are two sources and the caller never chooses between them — the
   * session does:
   *
   * - A signed-in customer who did not ask for anything else gets their own
   *   account's details, read here from the User row rather than taken from the
   *   token or from the body. Whatever `customerName`, `customerPhone` and
   *   `customerEmail` arrived with the request is discarded, which is what makes
   *   a forged default contact impossible rather than merely unlikely.
   * - Everybody else — a visitor with no session, an admin posting on the public
   *   endpoint, and a signed-in customer who ticked "different contact person" —
   *   supplies all three in the body, under exactly the rules they always were.
   *
   * An alternate contact belongs to the request alone: ownership is decided
   * separately by {@link resolveCustomerForCreate}, which still hands a
   * signed-in customer's request to that customer.
   *
   * Public because the vitrin lead path needs the same answer *before* it
   * creates the request: the proof of the telephone number has to be looked up
   * for the number the request will be stored with, and for a signed-in
   * customer that is the account's, not whatever the body carried.
   */
  async resolveContactDetails(
    dto: CreateServiceRequestDto,
    user: AuthUser | null,
  ): Promise<{ customerName: string; customerPhone: string; customerEmail: string }> {
    const usesAccountContact = user?.role === UserRole.CUSTOMER && dto.useAlternateContact !== true;

    if (!usesAccountContact) {
      return {
        customerName: normalizeRequiredString(dto.customerName, 'Customer name'),
        customerPhone: normalizePhone(dto.customerPhone),
        customerEmail: normalizeRequiredEmail(dto.customerEmail),
      };
    }

    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, phone: true, email: true },
    });

    const name = normalizeNullableString(account?.name);
    const phone = normalizeNullableString(account?.phone);
    const email = normalizeNullableString(account?.email);

    // An account may legitimately be missing any of the three — every column is
    // nullable, and a customer created by an older flow may never have been
    // asked. Refusing here is deliberate: the alternative is inventing a contact
    // for a request whose whole purpose is to be answered.
    if (!name || !phone || !email) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: ACCOUNT_CONTACT_INCOMPLETE_CODE,
        message:
          'Hesabınızda ad soyad, telefon ve e-posta bilgilerinin tamamı bulunmuyor. ' +
          'Talep oluşturmak için bu bilgileri tamamlayın veya farklı bir iletişim kişisi tanımlayın.',
      });
    }

    return {
      customerName: name,
      customerPhone: normalizePhone(phone),
      customerEmail: normalizeRequiredEmail(email),
    };
  }

  async listServiceRequests() {
    const requests = await this.prisma.serviceRequest.findMany({
      orderBy: { submittedAt: 'desc' },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        customer: {
          select: { id: true, email: true, phone: true, name: true },
        },
        _count: {
          select: { offers: true },
        },
      },
    });

    return requests.map((request) => ({
      ...withQualityLabel(request),
      offersCount: request._count.offers,
    }));
  }

  async listCustomerServiceRequests(customerId: string) {
    const requests = await this.prisma.serviceRequest.findMany({
      where: { customerId },
      orderBy: { submittedAt: 'desc' },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        _count: {
          // The customer's own count is of offers they can still act on. An
          // offer its provider withdrew is no longer one of them, and counting
          // it would promise a choice that is not there. The admin listing above
          // keeps the unfiltered total on purpose.
          select: { offers: { where: { status: { not: OfferStatus.WITHDRAWN } } } },
        },
        /*
         * The vitrin lead, when the request came from a card.
         *
         * On the customer's own list rather than behind a second endpoint,
         * because the decision it carries has to be *findable*: the fallback
         * question is mailed once and never chased, so a customer who deleted
         * the message needs to meet it again where they already look.
         *
         * Narrow on purpose. The customer is told which business they wrote to,
         * what they were promised and where the lead stands — and nothing about
         * the placement: not its id, not what it cost, not when it ends.
         */
        showcaseLeadSource: {
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
            cardVersion: { select: { title: true } },
            provider: { select: { id: true, businessName: true } },
          },
        },
      },
    });

    return requests.map(({ showcaseLeadSource, ...request }) => ({
      ...withQualityLabel(request),
      offersCount: request._count.offers,
      showcaseLead: showcaseLeadSource
        ? {
            id: showcaseLeadSource.id,
            status: showcaseLeadSource.status,
            urgencyBucket: showcaseLeadSource.urgencyBucket,
            slaHours: showcaseLeadSource.slaHoursSnapshot,
            slaDueAt: showcaseLeadSource.slaDueAt,
            breachedAt: showcaseLeadSource.breachedAt,
            fallbackAskedAt: showcaseLeadSource.fallbackAskedAt,
            fallbackDecision: showcaseLeadSource.fallbackDecision,
            fallbackDecidedAt: showcaseLeadSource.fallbackDecidedAt,
            releasedAt: showcaseLeadSource.releasedAt,
            closedAt: showcaseLeadSource.closedAt,
            closeReason: showcaseLeadSource.closeReason,
            createdAt: showcaseLeadSource.createdAt,
            cardTitle: showcaseLeadSource.cardVersion.title,
            kind: showcaseLeadSource.kindSnapshot,
            // Absent rather than null on a promotion card, exactly as the feed
            // does it: a client cannot render a price it was never given.
            ...(showcaseLeadSource.kindSnapshot === 'SERVICE'
              ? { listedServicePriceAmount: showcaseLeadSource.listedPriceSnapshot }
              : {}),
            provider: showcaseLeadSource.provider,
          }
        : null,
    }));
  }

  async getServiceRequest(id: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        customer: {
          select: { id: true, email: true, phone: true, name: true },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    return withQualityLabel(request);
  }

  async updateServiceRequestStatus(
    id: string,
    dto: UpdateServiceRequestStatusDto,
    user?: AuthUser | null,
  ) {
    const existing = await this.ensureRequestExists(id);
    const moderationNote = normalizeNullableString(dto.moderationNote);
    const rejectionReason = normalizeNullableString(dto.rejectionReason);

    // Approving is what publishes a request to providers, so it is the one
    // transition the verification gate has to cover. Rejecting or cancelling an
    // unverified request stays possible — an admin must still be able to clear
    // the queue. While the flag is false this branch never fires.
    if (
      dto.status === ServiceRequestStatus.APPROVED &&
      isPhoneVerificationRequired() &&
      !existing.phoneVerifiedAt
    ) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'PHONE_NOT_VERIFIED',
        message: 'Telefonu doğrulanmamış talep onaylanamaz.',
      });
    }

    if (nonModerationStatuses.has(dto.status)) {
      throw new ConflictException(
        `${dto.status} is not a moderation status and cannot be set from here`,
      );
    }

    if (dto.status === ServiceRequestStatus.REJECTED && !rejectionReason) {
      throw new BadRequestException('Rejection reason is required when status is REJECTED');
    }

    const shouldModerate = moderatedStatuses.has(dto.status);
    const now = new Date();

    const { request, publishes } = await runSerializable(
      this.prisma,
      async (tx) => {
        // The status as it is *now*, under the transaction, not as the
        // pre-flight read above saw it. `existing` decides what the operator
        // may ask for; this decides what the save actually changes. Between
        // the two the customer's own verification can publish the request
        // (`PhoneVerificationService.verifyCode`), and an approval that lands
        // on an already-live row must not book its fan-out a second time.
        const current = await tx.serviceRequest.findUniqueOrThrow({
          where: { id },
          select: { status: true, directShowcaseProviderId: true },
        });

        const include = {
          category: {
            select: { id: true, name: true, slug: true },
          },
          answers: {
            orderBy: { createdAt: 'asc' },
          },
        } satisfies Prisma.ServiceRequestInclude;

        let updated: Prisma.ServiceRequestGetPayload<{ include: typeof include }>;

        if (dto.status === ServiceRequestStatus.REJECTED) {
          /*
           * A refusal is a removal from the market, and the removal is one
           * cascade: the status, the vitrin lead, the live offers and every
           * credit those offers spent all move here, in this transaction —
           * see `rejectRequestInTransaction`. The moderation screen has no
           * private way of writing REJECTED that skips any of it.
           */
          await this.rejectRequestInTransaction(tx, {
            requestId: id,
            rejectionReason: rejectionReason!,
            moderationNote,
            actorUserId: user?.id ?? null,
            now,
          });
          updated = await tx.serviceRequest.findUniqueOrThrow({ where: { id }, include });
        } else {
          updated = await tx.serviceRequest.update({
            where: { id },
            data: {
              status: dto.status,
              moderationNote,
              rejectionReason: null,
              ...(shouldModerate ? { moderatedAt: now } : {}),
              // Written in the same statement that sets APPROVED, so the status and
              // the clock the expiry/reminder jobs run on can never disagree.
              //
              // Only ever set, never cleared: a re-approval refreshes the window (the
              // request really is open again from now), and a later transition to
              // MATCHED, COMPLETED, CANCELLED or REJECTED leaves the old value in
              // place as audit — nothing reads it once the status is no longer
              // APPROVED, and erasing it would destroy the record of when the request
              // went live.
              ...(dto.status === ServiceRequestStatus.APPROVED ? { approvedAt: now } : {}),
              ...(dto.status === ServiceRequestStatus.CANCELLED ? { cancelledAt: now } : {}),
            },
            include,
          });
        }

        /*
         * Only a real transition owes anybody a message. Re-saving an
         * already-approved request from the moderation screen rewrites
         * `approvedAt` and nothing else: the customer is not told twice that
         * their request went live, and no provider is invited to it a second
         * time. The dedupe key carries `approvedAt` as a second, database-level
         * guard against the same thing.
         *
         * **A direct vitrin lead is never fanned out**, and the gate is the
         * whole of the test. A request reserved for one business must not be
         * mailed to every business that matches it — that is the entire
         * promise a placement sells. Note what the condition reads: the
         * *gate*, not "did this come from a card". A released lead has a
         * cleared gate by the time it is approved, and it fans out exactly
         * like any other request, which is correct: by then it is one.
         *
         * Written down here, inside the approval's own transaction, so the
         * intents and the status commit as one fact; delivered after the
         * commit, below.
         */
        const publishes = isPublishingTransition(
          current.status,
          dto.status,
          updated.directShowcaseProviderId,
        );
        if (publishes) {
          await this.publishOutbox.enqueue(tx, id, now);
        }

        return { request: updated, publishes };
      },
      { label: 'serviceRequests.updateStatus' },
    );

    if (publishes) {
      this.publishOutbox.deliverSoon();
    }

    return withQualityLabel(request);
  }

  /** Statuses a request may be taken off the market from. MATCHED is not one. */
  static readonly REMOVABLE_STATUSES = [
    ServiceRequestStatus.APPROVED,
    ServiceRequestStatus.IN_REVIEW,
    ServiceRequestStatus.SUBMITTED,
  ] as const;

  /**
   * Takes a request off the market: REJECTED, its vitrin lead closed, its live
   * offers CANCELLED and every one-time credit they spent returned — all in
   * the caller's transaction, so none of it exists without the rest.
   *
   * The one writer of Offer.CANCELLED in the product. Both the moderation
   * screen's "Reddet" and a report's "Talebi kaldır" arrive here.
   *
   * Idempotent by construction rather than by flag. The conditional status
   * move is the gate: a request already REJECTED (or MATCHED, or anything else
   * off the list) matches nothing and the whole call is a 409 before any
   * offer is touched. Within one successful removal each credit comes back
   * exactly once, because the candidate filter, the helper's own conditional
   * update and the ledger's one-refund-per-offer index all say so — and a
   * refund the helper refuses throws, which rolls the status, the lead and
   * every other offer back with it. A MATCHED request is not removable: its
   * accepted offer is a contract the customer already entered, and the
   * lifecycle cancel endpoint is the door for that.
   */
  async rejectRequestInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      requestId: string;
      rejectionReason: string;
      moderationNote: string | null;
      actorUserId: string | null;
      now: Date;
    },
  ): Promise<{ cancelledOfferIds: string[]; refundedOfferIds: string[] }> {
    const { requestId, now } = input;
    const moved = await tx.serviceRequest.updateMany({
      where: { id: requestId, status: { in: [...ServiceRequestsService.REMOVABLE_STATUSES] } },
      data: {
        status: ServiceRequestStatus.REJECTED,
        rejectionReason: input.rejectionReason,
        moderationNote: input.moderationNote,
        moderatedAt: now,
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'REQUEST_NOT_REMOVABLE',
        message:
          'Bu talep mevcut durumundan kaldırılamaz; eşleşmiş talep için iptal kullanın, kapanmış talep zaten yayında değil.',
      });
    }

    // Otherwise an SLA clock would keep running against a business over a
    // request that no longer exists to answer. Quiet for the many requests
    // that have no lead.
    await this.showcaseLeads.closeForRequest(
      tx,
      requestId,
      ShowcaseLeadCloseReason.MODERATION_REJECTED,
      now,
    );

    // Read before the update, inside the transaction: exactly the set this
    // cascade closes and nothing else. A withdrawn, rejected or expired offer
    // has already ended on its own terms and is left as it is.
    const liveStatuses = [OfferStatus.SUBMITTED, OfferStatus.VIEWED, OfferStatus.SHORTLISTED];
    const live = await tx.offer.findMany({
      where: { requestId, status: { in: liveStatuses } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        providerId: true,
        creditCost: true,
        entitlementSource: true,
        creditSpentTransactionId: true,
        creditRefundedTransactionId: true,
      },
    });

    const closed = await tx.offer.updateMany({
      where: { id: { in: live.map((offer) => offer.id) }, status: { in: liveStatuses } },
      data: { status: OfferStatus.CANCELLED, cancelledAt: now },
    });
    // Serializable isolation makes a mismatch impossible; the check is here so
    // that "REJECTED with an offer still live" can never be committed even if
    // that guarantee is ever weakened.
    if (closed.count !== live.length) {
      throw new ConflictException('An offer on this request changed while it was being removed');
    }

    const refundedOfferIds: string[] = [];
    for (const offer of live) {
      // Only a one-time credit has a ledger row to give back. A period package
      // (quota / unlimited) and a vitrin lead spent none; they close and that
      // is all. An offer already refunded — by the unviewed sweeper, or by an
      // administrator's hand — keeps the refund it has.
      const refundable =
        offer.entitlementSource === OfferEntitlementSource.ONE_TIME_CREDIT &&
        offer.creditSpentTransactionId !== null &&
        offer.creditCost > 0 &&
        offer.creditRefundedTransactionId === null;
      if (!refundable) continue;

      // In full, viewed or not: the policy's "did the customer look" question
      // is about the customer's decision, and here nobody decided anything.
      // Throws on any guard failure, which rolls the whole removal back.
      await refundOfferCreditInTransaction(
        tx,
        { id: offer.id, providerId: offer.providerId, creditCost: offer.creditCost },
        REQUEST_REMOVED_REFUND_REASON,
        { enforceUnviewedPolicy: false, createdById: input.actorUserId },
      );
      refundedOfferIds.push(offer.id);
    }

    return { cancelledOfferIds: live.map((offer) => offer.id), refundedOfferIds };
  }

  /**
   * Puts back a request a report took down.
   *
   * Only that request: `REJECTED`, and with at least one report decided as
   * `REQUEST_REMOVED`. A request an operator refused by hand from the
   * moderation screen is not reopened from here — the screen's own "Onayla"
   * is the door for that, and a "reopen" that could re-approve any rejected
   * request would be a second approval endpoint with a narrower name.
   *
   * The reopening itself is the ordinary approval, with everything it
   * carries: the phone-verification gate, `approvedAt` refreshed (the fourteen
   * days start again — "re-approval refreshes the window"), `rejectionReason`
   * cleared, and the fan-out booked, deduped so a provider who was invited the
   * first time is not invited twice. The offers the removal CANCELLED stay
   * closed and the credits they gave back stay given: the reports are
   * append-only and so is the ledger, and the queue derives "reopened" from
   * the decision on the reports and the request's status, never from a flag.
   */
  async reopenAfterRemoval(id: string, moderationNote: string | null, user: AuthUser) {
    const existing = await this.prisma.serviceRequest.findUnique({
      where: { id },
      select: {
        status: true,
        reports: {
          where: { resolution: ServiceRequestReportResolution.REQUEST_REMOVED },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('Service request not found');
    }
    if (existing.status !== ServiceRequestStatus.REJECTED || existing.reports.length === 0) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'REQUEST_NOT_REOPENABLE',
        message: 'Yalnızca bildirim sonucu kaldırılmış bir talep geri açılabilir.',
      });
    }

    return this.updateServiceRequestStatus(
      id,
      { status: ServiceRequestStatus.APPROVED, moderationNote, rejectionReason: null },
      user,
    );
  }

  /**
   * Marks a matched request as delivered. Only the customer who owns it or a
   * SUPER_ADMIN may do this — a provider cannot declare its own job finished.
   *
   * The transition is a conditional update, so it is also the concurrency
   * guard: a second call finds no MATCHED row and gets a 409. It runs in a
   * transaction only so the review invitation can be written beside it;
   * nothing is sent until after the commit.
   */
  async completeServiceRequest(id: string, user: AuthUser) {
    const request = await this.getRequestForLifecycleAction(id, user);

    if (request.status !== ServiceRequestStatus.MATCHED) {
      throw new ConflictException('Only a matched request can be completed');
    }

    const now = new Date();

    await runSerializable(
      this.prisma,
      async (tx) => {
        const updated = await tx.serviceRequest.updateMany({
          where: { id, status: ServiceRequestStatus.MATCHED },
          data: { status: ServiceRequestStatus.COMPLETED, completedAt: now },
        });

        if (updated.count !== 1) {
          throw new ConflictException('Only a matched request can be completed');
        }

        // The invitation is owed by the same transaction that finished the job:
        // a crash between the two can no longer lose it, and a retry of this
        // request collides on (template, dedupeKey) and adds nothing.
        await this.reviewInvitations.enqueue(tx, id, now);
      },
      { label: 'serviceRequests.complete' },
    );

    this.reviewInvitations.deliverSoon();

    return this.getLifecycleProjection(id);
  }

  /** Cancels a request that has not finished yet. Customer (owner) or admin. */
  async cancelServiceRequest(id: string, user: AuthUser) {
    const request = await this.getRequestForLifecycleAction(id, user);

    if (terminalStatuses.has(request.status)) {
      throw new ConflictException(`A ${request.status} request can no longer be cancelled`);
    }

    const now = new Date();

    await runSerializable(
      this.prisma,
      async (tx) => {
        const updated = await tx.serviceRequest.updateMany({
          where: { id, status: { notIn: [...terminalStatuses] } },
          data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: now },
        });

        if (updated.count !== 1) {
          throw new ConflictException('This request can no longer be cancelled');
        }

        // The lead goes with it, for the reason a refusal closes one: a clock
        // running against a business over a cancelled request measures nothing
        // and asks the customer a question they have already answered.
        await this.showcaseLeads.closeForRequest(
          tx,
          id,
          ShowcaseLeadCloseReason.CUSTOMER_CANCELLED,
          now,
        );
      },
      { label: 'serviceRequests.cancel' },
    );

    return this.getLifecycleProjection(id);
  }

  private async getRequestForLifecycleAction(id: string, user: AuthUser) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id },
      select: { id: true, status: true, customerId: true },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      return request;
    }

    // Anything that is not the owning customer — providers included — is told
    // the request does not exist rather than that it exists but is off limits.
    if (user.role !== UserRole.CUSTOMER || !request.customerId || request.customerId !== user.id) {
      throw new ForbiddenException('Service request access denied');
    }

    return request;
  }

  private async getLifecycleProjection(id: string) {
    const request = await this.prisma.serviceRequest.findUniqueOrThrow({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return withQualityLabel(request);
  }

  async recalculateQuality(id: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id },
      include: {
        category: {
          include: {
            questions: {
              where: { isActive: true },
              orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
            },
          },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    const quality = calculateQualityScore({
      customerName: request.customerName,
      customerPhone: request.customerPhone,
      city: request.city,
      district: request.district,
      neighborhood: request.neighborhood,
      addressNote: request.addressNote,
      budgetMin: request.budgetMin,
      budgetMax: request.budgetMax,
      preferredDate: request.preferredDate,
      urgency: request.urgency,
      description: request.description,
      questions: request.category.questions,
      answers: request.answers,
    });

    const updated = await this.prisma.serviceRequest.update({
      where: { id },
      data: {
        qualityScore: quality.score,
        qualityScoreBreakdown: quality.breakdown,
      },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return withQualityLabel(updated);
  }

  private async ensureRequestExists(id: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id },
      select: { id: true, status: true, phoneVerifiedAt: true, showcaseLeadId: true },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    return request;
  }

  /**
   * Runs a notification and swallows whatever it throws.
   *
   * Every caller is past its commit point, so the only thing an escaping error
   * could do is turn a completed action into a failed response. The service it
   * calls already records failures in NotificationLog; this is the last guard
   * against a bug in the composing code rather than in the transport.
   */
  private async notify(run: () => Promise<unknown>, requestId: string) {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Failed to send a notification for request ${requestId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

async function resolveCustomerForCreate(
  tx: Prisma.TransactionClient,
  data: { customerName: string; customerPhone: string; customerEmail: string },
  user: AuthUser | null,
): Promise<string | null> {
  if (user && user.role === UserRole.CUSTOMER) {
    return user.id;
  }

  const phone = data.customerPhone;
  const email = data.customerEmail;

  const [byPhone, byEmail] = await Promise.all([
    tx.user.findFirst({
      where: { role: UserRole.CUSTOMER, phone },
      select: { id: true },
    }),
    tx.user.findFirst({
      where: { role: UserRole.CUSTOMER, email },
      select: { id: true },
    }),
  ]);

  if (byPhone && byEmail && byPhone.id !== byEmail.id) {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: CUSTOMER_IDENTITY_CONFLICT_CODE,
      message: 'Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.',
    });
  }

  if (byPhone) {
    return byPhone.id;
  }

  if (byEmail) {
    return byEmail.id;
  }

  try {
    const created = await tx.user.create({
      data: {
        role: UserRole.CUSTOMER,
        name: data.customerName,
        phone,
        email,
        isActive: true,
        passwordHash: null,
        customerOrigin: CustomerOrigin.AUTO_CREATED_REQUEST,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: CUSTOMER_IDENTITY_CONFLICT_CODE,
        message: 'Müşteri kaydı oluşturulamadı: telefon veya e-posta başka bir kayıtla çakışıyor.',
      });
    }
    throw error;
  }
}

function calculateQualityScore(input: QualityScoringInput) {
  const requiredQuestions = input.questions.filter((question) => question.isRequired);
  const optionalQuestions = input.questions.filter((question) => !question.isRequired);
  const answeredQuestionIds = new Set(
    input.answers
      .filter((answer) => hasAnswerValue(answer.value))
      .map((answer) => answer.questionId),
  );
  const requiredComplete =
    requiredQuestions.length === 0 ||
    requiredQuestions.every((question) => answeredQuestionIds.has(question.id));
  const optionalAnsweredCount = optionalQuestions.filter((question) =>
    answeredQuestionIds.has(question.id),
  ).length;
  const optionalRatio = optionalQuestions.length === 0 ? 0 : optionalAnsweredCount / optionalQuestions.length;
  const optionalPoints = Math.round(optionalRatio * 10);

  const breakdown: QualityBreakdown = {
    phonePresent: scoreFixed(Boolean(input.customerPhone?.trim()), 20),
    namePresent: scoreFixed(Boolean(input.customerName?.trim()), 10),
    cityDistrictPresent: scoreFixed(Boolean(input.city?.trim() && input.district?.trim()), 15),
    locationDetailPresent: scoreFixed(Boolean(input.neighborhood?.trim() || input.addressNote?.trim()), 10),
    budgetPresent: scoreFixed(input.budgetMin !== null || input.budgetMax !== null, 10),
    preferredDatePresent: scoreFixed(Boolean(input.preferredDate), 10),
    urgencyPresent: scoreFixed(Boolean(input.urgency?.trim()), 5),
    descriptionDetailed: scoreFixed((input.description?.trim().length ?? 0) >= 20, 10),
    requiredAnswersComplete: scoreFixed(requiredComplete, 10),
    optionalAnswersCompleted: {
      points: optionalPoints,
      max: 10,
      passed: optionalPoints > 0,
    },
  };
  const score = Math.min(
    100,
    Object.values(breakdown).reduce((total, component) => total + component.points, 0),
  );

  return { score, breakdown };
}

function scoreFixed(passed: boolean, max: number): QualityComponent {
  return {
    points: passed ? max : 0,
    max,
    passed,
  };
}

function hasAnswerValue(value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
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

/**
 * What the request should record about the contact-sharing disclosure.
 *
 * Creation *records* an acceptance; it no longer *demands* one. The demand
 * moved to the moment it is about — accepting an offer, which is the act that
 * opens the two parties' details to each other (see
 * OffersService.acceptRequestOffer). Asking at creation was both too early and
 * too coarse: too early because nothing is shared by submitting a request, and
 * too coarse because a customer who accepted months ago, before the wording
 * changed, would have their accept refused with nowhere to re-confirm.
 *
 * Requests created before this — and every guest request submitted by a form
 * that never showed the box — therefore stay acceptable: their customer is
 * asked at the accept screen instead, which is where the answer matters.
 *
 * The stored version always comes from configuration, never from the client.
 */
function resolveContactDisclosure(dto: CreateServiceRequestDto) {
  const config = readContactSharingConfig();
  if (!config.enabled || dto.contactDisclosureAccepted !== true) {
    return {};
  }

  const shown = dto.contactDisclosureVersion?.trim().toLowerCase();
  if (shown && shown !== config.disclosureVersion) {
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      code: CONTACT_DISCLOSURE_REQUIRED_CODE,
      message: 'Bilgilendirme metni güncellendi. Lütfen sayfayı yenileyip tekrar onaylayın.',
    });
  }

  return {
    contactDisclosureVersion: config.disclosureVersion,
    contactDisclosureAcceptedAt: new Date(),
  };
}

function withQualityLabel<T extends { qualityScore: number }>(request: T): T & { qualityLabel: QualityLabel } {
  return {
    ...request,
    qualityLabel: qualityLabel(request.qualityScore),
  };
}

/**
 * The router steps, in the shape an answer row takes.
 *
 * `value` is the option key, exactly as a SELECT answer to that question would
 * be — so a routed request's answers read like any other request's, and nothing
 * downstream needs to know a router was involved.
 */
function routerAnswerRows(
  routerAnswers: RoutingResolution['routerAnswers'],
): ValidatedAnswer[] {
  return routerAnswers.map((answer) => ({
    questionId: answer.questionId,
    questionKey: answer.questionKey,
    questionLabel: answer.questionLabel,
    questionType: answer.questionType,
    value: answer.value,
  }));
}

/**
 * Validates the submitted answers against the category's question set — and,
 * just as importantly, against which of those questions were actually on
 * screen.
 *
 * Three refusals live here, and each is a rule the client cannot be trusted
 * with:
 *
 *  - an answer for a question this category does not have;
 *  - an answer for a question whose visibility condition does not hold, so it
 *    was never shown and can carry no meaning;
 *  - an answer for a system-bound question, whose value belongs in the request
 *    column and must never be written a second time into an answer row.
 *
 * Visibility is re-derived here from the stored rules rather than taken from
 * the payload. The browser evaluates the same rules to decide what to render,
 * but a client that hid a condition, or invented one, changes nothing.
 */
function validateAnswers(
  questions: QuestionForValidation[],
  rawAnswers: CreateServiceRequestAnswerDto[],
  requestValues: SystemFieldRequestValues,
): ValidatedAnswer[] {
  const questionsByKey = new Map(questions.map((question) => [question.key, question]));
  const answersByKey = new Map<string, unknown>();

  for (const answer of rawAnswers) {
    const questionKey = normalizeRequiredString(answer.questionKey, 'Question key');
    const question = questionsByKey.get(questionKey);

    if (!question) {
      throw new BadRequestException(`Unknown questionKey: ${questionKey}`);
    }

    if (answersByKey.has(questionKey)) {
      throw new BadRequestException(`Duplicate answer for questionKey: ${questionKey}`);
    }

    if (question.systemField) {
      throw new BadRequestException(
        `${questionKey} sorusu talebin ${systemFieldLabel(question.systemField)} alanına bağlı; ` +
          'cevap olarak gönderilemez.',
      );
    }

    answersByKey.set(questionKey, answer.value);
  }

  const answersByQuestionId = new Map<string, unknown>(
    questions
      .filter((question) => answersByKey.has(question.key))
      .map((question) => [question.id, answersByKey.get(question.key)]),
  );

  const visibleIds = resolveVisibleQuestionIds(questions, answersByQuestionId);

  const validatedAnswers: ValidatedAnswer[] = [];

  for (const question of questions) {
    const visible = visibleIds.has(question.id);
    const rawValue = answersByKey.get(question.key);
    const hasValue = hasSubmittedValue(question.type, rawValue);

    if (!visible) {
      if (answersByKey.has(question.key)) {
        throw new BadRequestException(
          `${question.key} sorusu bu cevaplarla görünmüyor; yanıtlanamaz.`,
        );
      }

      continue;
    }

    // A bound question does not produce a row. Being required means the
    // built-in field it names has to carry a value — that is the only thing it
    // checks, and the value itself stays where it already is.
    if (question.systemField) {
      if (question.isRequired && !hasSystemFieldValue(question.systemField, requestValues)) {
        throw new BadRequestException(
          `${question.label} zorunlu: talebin ${systemFieldLabel(question.systemField)} alanı doldurulmalı.`,
        );
      }

      continue;
    }

    if (question.isRequired && !hasValue) {
      throw new BadRequestException(`Missing required answer: ${question.key}`);
    }

    if (!hasValue) {
      continue;
    }

    validatedAnswers.push({
      questionId: question.id,
      questionKey: question.key,
      questionLabel: question.label,
      questionType: question.type,
      value: validateAnswerValue(question, rawValue),
    });
  }

  return validatedAnswers;
}

function validateAnswerValue(question: ServiceRequestQuestion, value: unknown): Prisma.InputJsonValue {
  switch (question.type) {
    case ServiceRequestQuestionType.TEXT:
    case ServiceRequestQuestionType.TEXTAREA: {
      const text = normalizeRequiredString(value, question.label);
      assertNoContactDetails(`answers.${question.key}`, text);
      return text;
    }
    case ServiceRequestQuestionType.SELECT:
      return validateSelectValue(question, value);
    case ServiceRequestQuestionType.MULTI_SELECT:
      return validateMultiSelectValue(question, value);
    case ServiceRequestQuestionType.NUMBER:
      return validateNumberValue(question, value);
    case ServiceRequestQuestionType.BOOLEAN:
      return validateBooleanValue(question, value);
    case ServiceRequestQuestionType.DATE:
      return validateDateValue(question, value);
    case ServiceRequestQuestionType.IMAGE:
      return normalizeRequiredString(value, question.label);
  }
}

function validateSelectValue(question: ServiceRequestQuestion, value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${question.key} must be a select option key`);
  }

  const optionKeys = getOptionKeys(question);
  if (!optionKeys.has(value)) {
    throw new BadRequestException(`${question.key} must match one configured option`);
  }

  return value;
}

function validateMultiSelectValue(question: ServiceRequestQuestion, value: unknown) {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${question.key} must be an array of option keys`);
  }

  const optionKeys = getOptionKeys(question);
  const values = value.map((item) => {
    if (typeof item !== 'string' || !optionKeys.has(item)) {
      throw new BadRequestException(`${question.key} contains an invalid option`);
    }

    return item;
  });

  return values;
}

function validateNumberValue(question: ServiceRequestQuestion, value: unknown) {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isFinite(numberValue)) {
    throw new BadRequestException(`${question.key} must be numeric`);
  }

  return numberValue;
}

function validateBooleanValue(question: ServiceRequestQuestion, value: unknown) {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${question.key} must be boolean`);
  }

  return value;
}

function validateDateValue(question: ServiceRequestQuestion, value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${question.key} must be a date string`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${question.key} must be a valid date`);
  }

  return value;
}

function getOptionKeys(question: ServiceRequestQuestion) {
  if (!Array.isArray(question.options)) {
    throw new BadRequestException(`${question.key} has no configured options`);
  }

  const options = question.options as QuestionOption[];
  return new Set(options.map((option) => option.key));
}

function hasSubmittedValue(type: ServiceRequestQuestionType, value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (type === ServiceRequestQuestionType.MULTI_SELECT && Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
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

function normalizePhone(value: unknown) {
  return normalizeRequiredString(value, 'Customer phone').replace(/[^\d+]/g, '');
}

function normalizeRequiredEmail(value: unknown) {
  return normalizeRequiredString(value, 'Customer email').toLowerCase();
}

// Monetary amounts are stored in minor units (e.g. kuruş for TRY). When a customer
// supplies a budget, it must represent at least one whole currency unit (>= 100 minor
// units). null/undefined means "no preference" and is preserved as-is.
function normalizeOptionalPriceMinor(value: number | null | undefined, fieldName: string) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Number.isInteger(value) || value < 100) {
    throw new BadRequestException(
      `${fieldName} must be a positive integer in minor units (kuruş) and at least 100 (1,00).`,
    );
  }

  return value;
}

// A budget is a range, so the two ends have to be in that order. Equal ends are
// a range too — a customer with an exact figure gives the same number twice —
// but a minimum above the maximum describes nothing a provider could quote
// against, and would silently skew every budget-based comparison downstream.
// Either end may still be absent: "at least this much", "at most this much" and
// "no preference" are all valid.
function normalizeBudgetRange(
  min: number | null | undefined,
  max: number | null | undefined,
) {
  const budgetMin = normalizeOptionalPriceMinor(min, 'Budget minimum');
  const budgetMax = normalizeOptionalPriceMinor(max, 'Budget maximum');

  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
    throw new BadRequestException(
      'Budget minimum cannot be greater than budget maximum.',
    );
  }

  return { budgetMin, budgetMax };
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
