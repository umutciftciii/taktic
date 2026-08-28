import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { isPhoneVerificationRequired } from '../phone-verification/phone-verification.constants';
import { CustomerOrigin, NumberedEntityType, OfferStatus, Prisma, ServiceRequestQuestion, ServiceRequestQuestionType, ServiceRequestStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  CONTACT_DISCLOSURE_REQUIRED_CODE,
  readContactSharingConfig,
} from '../contact-sharing/contact-sharing.config';
import { CustomerActivationService } from '../customer-activation/customer-activation.service';
import { TransactionalMailService } from '../notifications/transactional-mail.service';
import { resolveLocation } from '../locations/turkey-locations';
import { NumberingService } from '../numbering/numbering.service';
import { CreateServiceRequestAnswerDto, CreateServiceRequestDto } from './dto/create-service-request.dto';
import { UpdateServiceRequestStatusDto } from './dto/update-service-request-status.dto';

type QuestionOption = {
  key: string;
  label: string;
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
  ) {}

  async createServiceRequest(dto: CreateServiceRequestDto, user: AuthUser | null = null) {
    if (user && user.role === UserRole.PROVIDER) {
      throw new ForbiddenException('Providers cannot create customer service requests');
    }

    const categorySlug = normalizeRequiredString(dto.categorySlug, 'Category slug');
    const category = await this.prisma.serviceCategory.findUnique({
      where: { slug: categorySlug },
      include: {
        questions: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
      },
    });

    if (!category || !category.isActive) {
      throw new NotFoundException('Category not found');
    }

    const answers = validateAnswers(category.questions, dto.answers ?? []);
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

    const requestData = {
      customerName: normalizeRequiredString(dto.customerName, 'Customer name'),
      customerPhone: normalizePhone(dto.customerPhone),
      customerEmail: normalizeRequiredEmail(dto.customerEmail),
      city: location.city,
      district: location.district,
      neighborhood: location.neighborhood,
      addressNote: normalizeNullableString(dto.addressNote),
      budgetMin: normalizeOptionalPriceMinor(dto.budgetMin, 'Budget minimum'),
      budgetMax: normalizeOptionalPriceMinor(dto.budgetMax, 'Budget maximum'),
      preferredDate,
      urgency: normalizeNullableString(dto.urgency),
      description: normalizeNullableString(dto.description),
    };
    const quality = calculateQualityScore({
      ...requestData,
      questions: category.questions,
      answers,
    });

    const request = await this.prisma.$transaction(async (tx) => {
      const customerId = await resolveCustomerForCreate(tx, requestData, user);
      const requestNumber = await this.numbering.generateDisplayNumber(
        tx,
        NumberedEntityType.SERVICE_REQUEST,
      );

      return tx.serviceRequest.create({
        data: {
          categoryId: category.id,
          customerId,
          requestNumber,
          ...requestData,
          ...disclosure,
          qualityScore: quality.score,
          qualityScoreBreakdown: quality.breakdown,
          answers: {
            create: answers,
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
    });

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

    // The receipt for the request the visitor just submitted. After the commit
    // and best-effort, for the same reason the activation link above is: the
    // request exists, and a mail problem must not surface as a failed
    // submission.
    await this.notify(() => this.mail.sendRequestReceived(request.id), request.id);

    return withQualityLabel(request);
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
      },
    });

    return requests.map((request) => ({
      ...withQualityLabel(request),
      offersCount: request._count.offers,
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

  async updateServiceRequestStatus(id: string, dto: UpdateServiceRequestStatusDto) {
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

    const request = await this.prisma.serviceRequest.update({
      where: { id },
      data: {
        status: dto.status,
        moderationNote,
        rejectionReason: dto.status === ServiceRequestStatus.REJECTED ? rejectionReason : null,
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
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Only a real transition mails anybody. Re-saving an already-approved
    // request from the moderation screen rewrites `approvedAt` and nothing
    // else: the customer is not told twice that their request went live, and no
    // provider is invited to it a second time. The dedupe key carries
    // `approvedAt` as a second, database-level guard against the same thing.
    if (
      dto.status === ServiceRequestStatus.APPROVED &&
      existing.status !== ServiceRequestStatus.APPROVED
    ) {
      await this.notify(() => this.mail.fanOutApprovedRequest(request.id, now), request.id);
    }

    return withQualityLabel(request);
  }

  /**
   * Marks a matched request as delivered. Only the customer who owns it or a
   * SUPER_ADMIN may do this — a provider cannot declare its own job finished.
   *
   * The transition is a conditional update, so it is also the concurrency
   * guard: a second call finds no MATCHED row and gets a 409.
   */
  async completeServiceRequest(id: string, user: AuthUser) {
    const request = await this.getRequestForLifecycleAction(id, user);

    if (request.status !== ServiceRequestStatus.MATCHED) {
      throw new ConflictException('Only a matched request can be completed');
    }

    const now = new Date();
    const updated = await this.prisma.serviceRequest.updateMany({
      where: { id, status: ServiceRequestStatus.MATCHED },
      data: { status: ServiceRequestStatus.COMPLETED, completedAt: now },
    });

    if (updated.count !== 1) {
      throw new ConflictException('Only a matched request can be completed');
    }

    return this.getLifecycleProjection(id);
  }

  /** Cancels a request that has not finished yet. Customer (owner) or admin. */
  async cancelServiceRequest(id: string, user: AuthUser) {
    const request = await this.getRequestForLifecycleAction(id, user);

    if (terminalStatuses.has(request.status)) {
      throw new ConflictException(`A ${request.status} request can no longer be cancelled`);
    }

    const now = new Date();
    const updated = await this.prisma.serviceRequest.updateMany({
      where: { id, status: { notIn: [...terminalStatuses] } },
      data: { status: ServiceRequestStatus.CANCELLED, cancelledAt: now },
    });

    if (updated.count !== 1) {
      throw new ConflictException('This request can no longer be cancelled');
    }

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
      select: { id: true, status: true, phoneVerifiedAt: true },
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
    throw new ConflictException('Telefon ve e-posta farklı müşteri kayıtlarıyla eşleşiyor.');
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
      throw new ConflictException(
        'Müşteri kaydı oluşturulamadı: telefon veya e-posta başka bir kayıtla çakışıyor.',
      );
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

function validateAnswers(
  questions: ServiceRequestQuestion[],
  rawAnswers: CreateServiceRequestAnswerDto[],
): ValidatedAnswer[] {
  const questionsByKey = new Map(questions.map((question) => [question.key, question]));
  const answersByKey = new Map<string, unknown>();

  for (const answer of rawAnswers) {
    const questionKey = normalizeRequiredString(answer.questionKey, 'Question key');

    if (!questionsByKey.has(questionKey)) {
      throw new BadRequestException(`Unknown questionKey: ${questionKey}`);
    }

    if (answersByKey.has(questionKey)) {
      throw new BadRequestException(`Duplicate answer for questionKey: ${questionKey}`);
    }

    answersByKey.set(questionKey, answer.value);
  }

  const validatedAnswers: ValidatedAnswer[] = [];

  for (const question of questions) {
    const rawValue = answersByKey.get(question.key);
    const hasValue = hasSubmittedValue(question.type, rawValue);

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
    case ServiceRequestQuestionType.TEXTAREA:
      return normalizeRequiredString(value, question.label);
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

function normalizePhone(value: string) {
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
