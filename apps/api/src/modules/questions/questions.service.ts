import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ServiceCategoryKind,
  ServiceRequestQuestion,
  ServiceRequestQuestionSystemField,
  ServiceRequestQuestionType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  questionWithRulesInclude,
  serializeQuestion,
} from '../categories/category-serialization';
import { CreateQuestionDto } from './dto/create-question.dto';
import { ReplaceQuestionConditionsDto } from './dto/replace-question-conditions.dto';
import { ReplaceRouterRulesDto } from './dto/replace-router-rules.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { assertSystemFieldTypeMatches } from './question-system-fields';

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

    const questions = await this.prisma.serviceRequestQuestion.findMany({
      where: { categoryId },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      include: questionWithRulesInclude,
    });

    // Admin-only endpoint (see QuestionsController), so the routing
    // destinations travel: managing them is what this listing is for.
    return questions.map((question) => serializeQuestion(question, { exposeRouterTargets: true }));
  }

  async createQuestion(categoryId: string, dto: CreateQuestionDto) {
    const category = await this.ensureCategoryExists(categoryId);
    const options = normalizeQuestionOptions(dto.type, dto.options);
    const systemField = dto.systemField ?? null;
    const isRouter = dto.isRouter ?? false;

    assertSystemFieldTypeMatches(systemField, dto.type);
    assertRouterShape({ category, isRouter, systemField, type: dto.type });

    if (isRouter) {
      await this.assertNoOtherRouterQuestion(categoryId, null);
    }

    try {
      return await this.prisma.serviceRequestQuestion.create({
        data: {
          categoryId,
          key: normalizeQuestionKey(dto.key),
          label: normalizeRequiredString(dto.label, 'Question label'),
          helpText: normalizeNullableString(dto.helpText),
          type: dto.type,
          isRequired: dto.isRequired,
          options,
          systemField,
          isRouter,
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
    const category = await this.ensureCategoryExists(existing.categoryId);
    const nextType = dto.type ?? existing.type;
    const nextOptions = dto.options !== undefined ? dto.options : existing.options;
    const options = normalizeQuestionOptions(nextType, nextOptions);
    const nextSystemField =
      dto.systemField !== undefined ? dto.systemField : existing.systemField;
    const nextIsRouter = dto.isRouter !== undefined ? dto.isRouter : existing.isRouter;

    assertSystemFieldTypeMatches(nextSystemField, nextType);
    assertRouterShape({
      category,
      isRouter: nextIsRouter,
      systemField: nextSystemField,
      type: nextType,
    });

    if (nextIsRouter) {
      await this.assertNoOtherRouterQuestion(existing.categoryId, id);
    }

    // Narrowing the option set out from under a rule that names one of the
    // removed keys would leave a router pointing at an option nobody can pick,
    // or a condition that can never hold. Both are refused here rather than
    // becoming a dead branch somebody debugs later.
    if (dto.options !== undefined || dto.type !== undefined) {
      await this.assertRulesStillReferenceRealOptions(id, nextType, options);
    }

    try {
      return await this.prisma.serviceRequestQuestion.update({
        where: { id },
        data: {
          ...(dto.key !== undefined ? { key: normalizeQuestionKey(dto.key) } : {}),
          ...(dto.label !== undefined ? { label: normalizeRequiredString(dto.label, 'Question label') } : {}),
          ...(dto.helpText !== undefined ? { helpText: normalizeNullableString(dto.helpText) } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.isRequired !== undefined ? { isRequired: dto.isRequired } : {}),
          options,
          ...(dto.systemField !== undefined ? { systemField: dto.systemField } : {}),
          ...(dto.isRouter !== undefined ? { isRouter: dto.isRouter } : {}),
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

  /**
   * Replaces a question's visibility rules wholesale.
   *
   * A replace rather than add/remove endpoints: the rules on one question are
   * ANDed together, so they only mean anything as a set, and editing them one
   * row at a time gives the admin screen intermediate states that show the
   * wrong questions to customers.
   */
  async replaceConditions(questionId: string, dto: ReplaceQuestionConditionsDto) {
    const question = await this.ensureQuestionExists(questionId);

    const sourceKeys = (dto.conditions ?? []).map((condition) => condition.sourceQuestionKey);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new BadRequestException('Aynı kaynak soru için birden fazla koşul verilemez');
    }

    // Sources are looked up *within this question's category*. That is the
    // rule that stops a condition from binding to another category's question:
    // a key that exists elsewhere simply is not found here.
    const siblings = await this.prisma.serviceRequestQuestion.findMany({
      where: { categoryId: question.categoryId },
      select: { id: true, key: true, type: true, options: true, sortOrder: true },
    });
    const byKey = new Map(siblings.map((sibling) => [sibling.key, sibling]));

    const rows = (dto.conditions ?? []).map((condition) => {
      const source = byKey.get(condition.sourceQuestionKey);

      if (!source) {
        throw new BadRequestException(
          `Kaynak soru bu kategoride yok: ${condition.sourceQuestionKey}`,
        );
      }

      if (source.id === questionId) {
        throw new BadRequestException('Bir soru kendi görünürlüğünün kaynağı olamaz');
      }

      if (!optionQuestionTypes.has(source.type)) {
        throw new BadRequestException(
          'Koşul kaynağı yalnızca SELECT veya MULTI_SELECT tipinde bir soru olabilir',
        );
      }

      // The ordering rule that makes the dependency graph acyclic by
      // construction — see resolveVisibleQuestionIds, which relies on it to
      // evaluate visibility in a single ordered pass.
      if (source.sortOrder >= question.sortOrder) {
        throw new BadRequestException(
          `Kaynak soru (${source.key}) hedef sorudan önce sıralanmalı`,
        );
      }

      const optionKeys = optionKeysOf(source.options);
      const expectedValues = normalizeExpectedValues(condition.expectedValues);

      for (const value of expectedValues) {
        if (!optionKeys.has(value)) {
          throw new BadRequestException(
            `${source.key} sorusunda ${value} seçeneği tanımlı değil`,
          );
        }
      }

      return { questionId, sourceQuestionId: source.id, expectedValues };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceRequestQuestionCondition.deleteMany({ where: { questionId } });
      if (rows.length > 0) {
        await tx.serviceRequestQuestionCondition.createMany({ data: rows });
      }
    });

    return this.getQuestionWithRules(questionId);
  }

  /**
   * Replaces a routing question's destinations wholesale, for the same reason
   * conditions are replaced rather than patched: a router is only meaningful as
   * a complete option→destination map.
   */
  async replaceRouterRules(questionId: string, dto: ReplaceRouterRulesDto) {
    const question = await this.ensureQuestionExists(questionId);
    const category = await this.ensureCategoryExists(question.categoryId);

    if (category.kind !== ServiceCategoryKind.ROUTER) {
      throw new BadRequestException(
        'Yönlendirme kuralı yalnızca ROUTER tipindeki bir kategorinin sorusuna eklenebilir',
      );
    }

    if (!question.isRouter) {
      throw new BadRequestException('Bu soru kategorinin yönlendirme sorusu değil');
    }

    const optionKeys = optionKeysOf(question.options);
    const rules = dto.rules ?? [];
    const seen = new Set<string>();

    for (const rule of rules) {
      if (!optionKeys.has(rule.optionKey)) {
        throw new BadRequestException(
          `${question.key} sorusunda ${rule.optionKey} seçeneği tanımlı değil`,
        );
      }

      if (seen.has(rule.optionKey)) {
        throw new BadRequestException(
          `${rule.optionKey} seçeneği için birden fazla hedef verilemez`,
        );
      }

      seen.add(rule.optionKey);
    }

    const targetSlugs = [...new Set(rules.map((rule) => rule.targetCategorySlug))];
    const targets = await this.prisma.serviceCategory.findMany({
      where: { slug: { in: targetSlugs } },
      select: { id: true, slug: true, kind: true },
    });
    const targetBySlug = new Map(targets.map((target) => [target.slug, target]));

    const rows = rules.map((rule, index) => {
      const target = targetBySlug.get(rule.targetCategorySlug);

      if (!target) {
        throw new BadRequestException(`Hedef kategori bulunamadı: ${rule.targetCategorySlug}`);
      }

      if (target.id === category.id) {
        throw new BadRequestException('Bir yönlendirici kendini hedefleyemez');
      }

      // A group is a folder: routing to it would put the customer on a
      // category no request can ever attach to.
      if (target.kind === ServiceCategoryKind.GROUP) {
        throw new BadRequestException(
          `${rule.targetCategorySlug} bir grup kategorisi; yönlendirme hedefi olamaz`,
        );
      }

      return {
        questionId,
        optionKey: rule.optionKey,
        targetCategoryId: target.id,
        sortOrder: rule.sortOrder ?? index * 10,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceCategoryRouterRule.deleteMany({ where: { questionId } });
      if (rows.length > 0) {
        await tx.serviceCategoryRouterRule.createMany({ data: rows });
      }
    });

    return this.getQuestionWithRules(questionId);
  }

  private async getQuestionWithRules(id: string) {
    const question = await this.prisma.serviceRequestQuestion.findUniqueOrThrow({
      where: { id },
      include: questionWithRulesInclude,
    });

    return serializeQuestion(question, { exposeRouterTargets: true });
  }

  /**
   * "At most one router question per category", enforced here rather than by a
   * partial unique index so `prisma migrate dev` keeps reporting no drift
   * against the schema file.
   */
  private async assertNoOtherRouterQuestion(categoryId: string, exceptId: string | null) {
    const other = await this.prisma.serviceRequestQuestion.findFirst({
      where: {
        categoryId,
        isRouter: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { key: true },
    });

    if (other) {
      throw new ConflictException(
        `Bu kategorinin yönlendirme sorusu zaten var: ${other.key}`,
      );
    }
  }

  private async assertRulesStillReferenceRealOptions(
    questionId: string,
    type: ServiceRequestQuestionType,
    options: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
  ) {
    const optionKeys = optionQuestionTypes.has(type)
      ? new Set((options as QuestionOption[]).map((option) => option.key))
      : new Set<string>();

    const [routerRules, dependents] = await Promise.all([
      this.prisma.serviceCategoryRouterRule.findMany({
        where: { questionId },
        select: { optionKey: true },
      }),
      this.prisma.serviceRequestQuestionCondition.findMany({
        where: { sourceQuestionId: questionId },
        select: { expectedValues: true },
      }),
    ]);

    for (const rule of routerRules) {
      if (!optionKeys.has(rule.optionKey)) {
        throw new ConflictException(
          `${rule.optionKey} seçeneği bir yönlendirme kuralında kullanılıyor; önce kuralı güncelleyin.`,
        );
      }
    }

    for (const dependent of dependents) {
      for (const value of dependent.expectedValues) {
        if (!optionKeys.has(value)) {
          throw new ConflictException(
            `${value} seçeneği bir görünürlük kuralında kullanılıyor; önce kuralı güncelleyin.`,
          );
        }
      }
    }
  }

  private async ensureCategoryExists(categoryId: string) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, kind: true, slug: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  private async ensureQuestionExists(id: string): Promise<ServiceRequestQuestion> {
    const question = await this.prisma.serviceRequestQuestion.findUnique({
      where: { id },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    return question;
  }
}

/**
 * The three shapes a question may not have.
 *
 * A router question decides which category the request lands on, so it has to
 * be a single choice from a fixed list — a free-text or multi-select router is
 * not a decision, and a router bound to a request column is two different jobs
 * on one row.
 */
function assertRouterShape(input: {
  category: { kind: ServiceCategoryKind };
  isRouter: boolean;
  systemField: ServiceRequestQuestionSystemField | null;
  type: ServiceRequestQuestionType;
}) {
  if (!input.isRouter) {
    return;
  }

  if (input.category.kind !== ServiceCategoryKind.ROUTER) {
    throw new BadRequestException(
      'Yönlendirme sorusu yalnızca ROUTER tipindeki bir kategoriye eklenebilir',
    );
  }

  if (input.type !== ServiceRequestQuestionType.SELECT) {
    throw new BadRequestException('Yönlendirme sorusu SELECT tipinde olmalı');
  }

  if (input.systemField !== null) {
    throw new BadRequestException('Yönlendirme sorusu bir sistem alanına bağlanamaz');
  }
}

function optionKeysOf(options: Prisma.JsonValue | null | undefined): Set<string> {
  if (!Array.isArray(options)) {
    return new Set();
  }

  return new Set(
    options
      .map((option) =>
        option && typeof option === 'object' && !Array.isArray(option)
          ? (option as Record<string, unknown>).key
          : null,
      )
      .filter((key): key is string => typeof key === 'string'),
  );
}

function normalizeExpectedValues(values: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);

  if (normalized.length === 0) {
    throw new BadRequestException('Koşul en az bir beklenen değer içermeli');
  }

  return [...new Set(normalized)];
}

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredString(value: string, fieldName: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new BadRequestException(`${fieldName} cannot be empty`);
  }

  return trimmed;
}

function normalizeQuestionKey(value: string) {
  const key = normalizeRequiredString(value, 'Question key');

  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(key)) {
    throw new BadRequestException('Question key must be lowercase and stable');
  }

  return key;
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
