import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ServiceRequestQuestionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';

const optionQuestionTypes = new Set<ServiceRequestQuestionType>([
  ServiceRequestQuestionType.SELECT,
  ServiceRequestQuestionType.MULTI_SELECT,
]);

type QuestionOption = {
  key: string;
  label: string;
};

@Injectable()
export class QuestionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listQuestions(categoryId: string) {
    await this.ensureCategoryExists(categoryId);

    return this.prisma.serviceRequestQuestion.findMany({
      where: { categoryId },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createQuestion(categoryId: string, dto: CreateQuestionDto) {
    await this.ensureCategoryExists(categoryId);
    const options = normalizeQuestionOptions(dto.type, dto.options);

    try {
      return await this.prisma.serviceRequestQuestion.create({
        data: {
          categoryId,
          key: dto.key,
          label: dto.label.trim(),
          helpText: normalizeNullableString(dto.helpText),
          type: dto.type,
          isRequired: dto.isRequired,
          options,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (error) {
      handleQuestionWriteError(error);
    }
  }

  async updateQuestion(id: string, dto: UpdateQuestionDto) {
    const existing = await this.ensureQuestionExists(id);
    const nextType = dto.type ?? existing.type;
    const nextOptions = dto.options !== undefined ? dto.options : existing.options;
    const options = normalizeQuestionOptions(nextType, nextOptions);

    try {
      return await this.prisma.serviceRequestQuestion.update({
        where: { id },
        data: {
          ...(dto.key !== undefined ? { key: dto.key } : {}),
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.helpText !== undefined ? { helpText: normalizeNullableString(dto.helpText) } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.isRequired !== undefined ? { isRequired: dto.isRequired } : {}),
          options,
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (error) {
      handleQuestionWriteError(error);
    }
  }

  async updateQuestionStatus(id: string, isActive: boolean) {
    await this.ensureQuestionExists(id);

    return this.prisma.serviceRequestQuestion.update({
      where: { id },
      data: { isActive },
    });
  }

  private async ensureCategoryExists(categoryId: string) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }
  }

  private async ensureQuestionExists(id: string) {
    const question = await this.prisma.serviceRequestQuestion.findUnique({
      where: { id },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return question;
  }
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeQuestionOptions(
  type: ServiceRequestQuestionType,
  value: Prisma.JsonValue | unknown[] | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (!optionQuestionTypes.has(type)) {
    return Prisma.JsonNull;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException('SELECT and MULTI_SELECT questions require options');
  }

  const options = value.map((option) => parseOption(option));
  const keys = new Set(options.map((option) => option.key));

  if (keys.size !== options.length) {
    throw new BadRequestException('Question option keys must be unique');
  }

  return options;
}

function parseOption(option: unknown): QuestionOption {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new BadRequestException('Question options must be objects with key and label');
  }

  const record = option as Record<string, unknown>;
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  const label = typeof record.label === 'string' ? record.label.trim() : '';

  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(key) || !label) {
    throw new BadRequestException('Question options must include stable key and label');
  }

  return { key, label };
}

function handleQuestionWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictException('Question key already exists for this category');
    }

    if (error.code === 'P2003') {
      throw new BadRequestException('Category does not exist');
    }
  }

  throw error;
}
