import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServiceRequestQuestion, ServiceRequestQuestionType, ServiceRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateServiceRequestAnswerDto, CreateServiceRequestDto } from './dto/create-service-request.dto';

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

@Injectable()
export class ServiceRequestsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createServiceRequest(dto: CreateServiceRequestDto) {
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

    return this.prisma.serviceRequest.create({
      data: {
        categoryId: category.id,
        customerName: normalizeRequiredString(dto.customerName, 'Customer name'),
        customerPhone: normalizePhone(dto.customerPhone),
        customerEmail: normalizeNullableString(dto.customerEmail),
        city: normalizeRequiredString(dto.city, 'City'),
        district: normalizeRequiredString(dto.district, 'District'),
        neighborhood: normalizeNullableString(dto.neighborhood),
        addressNote: normalizeNullableString(dto.addressNote),
        budgetMin: normalizeOptionalInteger(dto.budgetMin, 'Budget minimum'),
        budgetMax: normalizeOptionalInteger(dto.budgetMax, 'Budget maximum'),
        preferredDate,
        urgency: normalizeNullableString(dto.urgency),
        description: normalizeNullableString(dto.description),
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
  }

  listServiceRequests() {
    return this.prisma.serviceRequest.findMany({
      orderBy: { submittedAt: 'desc' },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
      },
    });
  }

  async getServiceRequest(id: string) {
    const request = await this.prisma.serviceRequest.findUnique({
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

    if (!request) {
      throw new NotFoundException('Service request not found');
    }

    return request;
  }

  async updateServiceRequestStatus(id: string, status: ServiceRequestStatus) {
    await this.ensureRequestExists(id);

    return this.prisma.serviceRequest.update({
      where: { id },
      data: { status },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        answers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
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

function normalizeOptionalInteger(value: number | null | undefined, fieldName: string) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${fieldName} must be a positive integer`);
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
