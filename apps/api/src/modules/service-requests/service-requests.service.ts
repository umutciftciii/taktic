import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NumberedEntityType, Prisma, ServiceRequestQuestion, ServiceRequestQuestionType, ServiceRequestStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
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

@Injectable()
export class ServiceRequestsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  async createServiceRequest(dto: CreateServiceRequestDto, user: AuthUser | null = null) {
    const customerId = resolveCustomerIdForCreate(user);
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
    const requestData = {
      customerName: normalizeRequiredString(dto.customerName, 'Customer name'),
      customerPhone: normalizePhone(dto.customerPhone),
      customerEmail: normalizeNullableString(dto.customerEmail),
      city: normalizeRequiredString(dto.city, 'City'),
      district: normalizeRequiredString(dto.district, 'District'),
      neighborhood: normalizeNullableString(dto.neighborhood),
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
          select: { offers: true },
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
    await this.ensureRequestExists(id);
    const moderationNote = normalizeNullableString(dto.moderationNote);
    const rejectionReason = normalizeNullableString(dto.rejectionReason);

    if (dto.status === ServiceRequestStatus.REJECTED && !rejectionReason) {
      throw new BadRequestException('Rejection reason is required when status is REJECTED');
    }

    const shouldModerate = moderatedStatuses.has(dto.status);

    const request = await this.prisma.serviceRequest.update({
      where: { id },
      data: {
        status: dto.status,
        moderationNote,
        rejectionReason: dto.status === ServiceRequestStatus.REJECTED ? rejectionReason : null,
        ...(shouldModerate ? { moderatedAt: new Date() } : {}),
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
      select: { id: true },
    });

    if (!request) {
      throw new NotFoundException('Service request not found');
    }
  }
}

function resolveCustomerIdForCreate(user: AuthUser | null) {
  if (!user) {
    return null;
  }

  if (user.role === UserRole.CUSTOMER) {
    return user.id;
  }

  if (user.role === UserRole.SUPER_ADMIN) {
    return null;
  }

  throw new ForbiddenException('Providers cannot create customer service requests');
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
