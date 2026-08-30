import type { PrismaClient, ServiceCategory } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { CategoryDefinition, CategoryWave, QuestionDefinition } from './types';

/**
 * Applies a category wave, idempotently.
 *
 * "Idempotent" here means something specific and testable: running the import a
 * second time changes nothing an operator would notice. The import owns the
 * *structure* of a wave — which categories exist, what they are called, which
 * questions they ask, which options those questions offer, which rules govern
 * them — and re-running it brings that structure back in line with the file.
 *
 * It deliberately does not own three things, because they are decisions people
 * make after the import has run:
 *
 *   status / isActive   Releasing a draft is an operator's call. An import that
 *                       could put an unfinished category on the public
 *                       catalogue — or take a live one off it — is not a script
 *                       anybody should be comfortable running twice.
 *   offerCreditCost     Set once, on creation, and never rewritten. Same rule
 *                       the seed already applies to the founding categories.
 *   providerEnrollmentOpen
 *                       Set once, on creation. Closing a draft to provider
 *                       applications is a decision somebody makes — a regulated
 *                       service is the obvious case — and reopening it on the
 *                       next run would undo that silently.
 *   unknown questions   A question somebody added by hand is left alone. This
 *                       import adds and updates; it never sweeps.
 *
 * Nothing here reads a CSV, a network resource or an environment variable. It
 * takes a wave and a client, and every side effect is a row in one of five
 * tables.
 */

export type ImportSummary = {
  wave: string;
  categoriesCreated: number;
  categoriesUpdated: number;
  questionsCreated: number;
  questionsUpdated: number;
  conditionsWritten: number;
  routerRulesWritten: number;
};

export async function importCategoryWave(
  prisma: PrismaClient,
  wave: CategoryWave,
): Promise<ImportSummary> {
  assertWaveIsCoherent(wave);

  const summary: ImportSummary = {
    wave: wave.name,
    categoriesCreated: 0,
    categoriesUpdated: 0,
    questionsCreated: 0,
    questionsUpdated: 0,
    conditionsWritten: 0,
    routerRulesWritten: 0,
  };

  const categoriesBySlug = new Map<string, ServiceCategory>();

  for (const definition of wave.categories) {
    const existing = await prisma.serviceCategory.findUnique({
      where: { slug: definition.slug },
    });

    const parentId = definition.parentSlug
      ? (categoriesBySlug.get(definition.parentSlug)?.id ??
        (
          await prisma.serviceCategory.findUniqueOrThrow({
            where: { slug: definition.parentSlug },
            select: { id: true },
          })
        ).id)
      : null;

    const structure = {
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      parentId,
      sortOrder: definition.sortOrder,
      iconKey: definition.iconKey ?? null,
    };

    const saved = existing
      ? await prisma.serviceCategory.update({
          where: { id: existing.id },
          data: {
            ...structure,
            // Filled only if the category never had a price. An admin who
            // repriced it keeps their number.
            ...(existing.offerCreditCost === null && definition.offerCreditCost !== undefined
              ? { offerCreditCost: definition.offerCreditCost }
              : {}),
          },
        })
      : await prisma.serviceCategory.create({
          data: {
            slug: definition.slug,
            ...structure,
            status: definition.status,
            isActive: definition.status === 'ACTIVE',
            offerCreditCost: definition.offerCreditCost ?? null,
            // Set once, like the price above. An operator who closed a draft to
            // applications keeps it closed through the next import.
            providerEnrollmentOpen: definition.providerEnrollmentOpen ?? false,
          },
        });

    if (existing) {
      summary.categoriesUpdated += 1;
    } else {
      summary.categoriesCreated += 1;
    }

    categoriesBySlug.set(definition.slug, saved);
  }

  // Questions in a second pass, and their rules in a third: a condition names a
  // sibling question and a router rule names another category, so both need
  // every row of the pass before them to exist.
  const questionIds = new Map<string, string>();

  for (const definition of wave.categories) {
    const category = categoriesBySlug.get(definition.slug);
    if (!category) {
      continue;
    }

    for (const question of definition.questions ?? []) {
      const existing = await prisma.serviceRequestQuestion.findUnique({
        where: { categoryId_key: { categoryId: category.id, key: question.key } },
        select: { id: true },
      });

      const data = {
        label: question.label,
        helpText: question.helpText ?? null,
        type: question.type,
        isRequired: question.isRequired,
        options: (question.options ?? null) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
        systemField: question.systemField ?? null,
        isRouter: question.isRouter ?? false,
        sortOrder: question.sortOrder,
        isActive: true,
      };

      const saved = existing
        ? await prisma.serviceRequestQuestion.update({
            where: { id: existing.id },
            data: {
              ...data,
              options: question.options ? question.options : Prisma.JsonNull,
            },
          })
        : await prisma.serviceRequestQuestion.create({
            data: {
              categoryId: category.id,
              key: question.key,
              ...data,
              options: question.options ? question.options : Prisma.JsonNull,
            },
          });

      if (existing) {
        summary.questionsUpdated += 1;
      } else {
        summary.questionsCreated += 1;
      }

      questionIds.set(questionKey(definition.slug, question.key), saved.id);
    }
  }

  for (const definition of wave.categories) {
    for (const question of definition.questions ?? []) {
      const id = questionIds.get(questionKey(definition.slug, question.key));
      if (!id) {
        continue;
      }

      // Replace rather than merge, for the same reason the admin endpoints do:
      // the rules on one question only mean anything as a complete set, and a
      // leftover row from a previous shape of the file is a rule nobody wrote.
      await prisma.serviceRequestQuestionCondition.deleteMany({ where: { questionId: id } });
      for (const condition of question.conditions ?? []) {
        const sourceId = questionIds.get(
          questionKey(definition.slug, condition.sourceQuestionKey),
        );

        if (!sourceId) {
          throw new Error(
            `${definition.slug}/${question.key}: koşul kaynağı bulunamadı (${condition.sourceQuestionKey})`,
          );
        }

        await prisma.serviceRequestQuestionCondition.create({
          data: {
            questionId: id,
            sourceQuestionId: sourceId,
            expectedValues: condition.expectedValues,
            // Omitted means ANY, which is both the column default and what a
            // wave written before the mode existed meant.
            ...(condition.matchMode ? { matchMode: condition.matchMode } : {}),
          },
        });
        summary.conditionsWritten += 1;
      }

      await prisma.serviceCategoryRouterRule.deleteMany({ where: { questionId: id } });
      for (const [index, rule] of (question.routerRules ?? []).entries()) {
        const target = await prisma.serviceCategory.findUnique({
          where: { slug: rule.targetCategorySlug },
          select: { id: true },
        });

        if (!target) {
          throw new Error(
            `${definition.slug}/${question.key}: yönlendirme hedefi bulunamadı (${rule.targetCategorySlug})`,
          );
        }

        await prisma.serviceCategoryRouterRule.create({
          data: {
            questionId: id,
            optionKey: rule.optionKey,
            targetCategoryId: target.id,
            sortOrder: index * 10,
          },
        });
        summary.routerRulesWritten += 1;
      }
    }
  }

  return summary;
}

function questionKey(categorySlug: string, key: string) {
  return `${categorySlug}::${key}`;
}

/**
 * Everything about a wave that can be checked without a database, checked
 * before the first row is written.
 *
 * A half-applied wave is the worst outcome here — a category whose questions
 * exist and whose routing does not is a form that dead-ends — so the shape
 * errors are found up front rather than three inserts in.
 */
function assertWaveIsCoherent(wave: CategoryWave) {
  const slugs = new Set<string>();

  for (const definition of wave.categories) {
    if (slugs.has(definition.slug)) {
      throw new Error(`Yinelenen kategori slug'ı: ${definition.slug}`);
    }
    slugs.add(definition.slug);
  }

  for (const definition of wave.categories) {
    if (definition.parentSlug && definition.parentSlug === definition.slug) {
      throw new Error(`${definition.slug} kendi üst kategorisi olamaz`);
    }

    assertQuestionsAreCoherent(definition);
  }
}

function assertQuestionsAreCoherent(definition: CategoryDefinition) {
  const questions = definition.questions ?? [];
  const byKey = new Map<string, QuestionDefinition>();

  for (const question of questions) {
    if (byKey.has(question.key)) {
      throw new Error(`${definition.slug}: yinelenen soru anahtarı ${question.key}`);
    }
    byKey.set(question.key, question);
  }

  const routers = questions.filter((question) => question.isRouter);
  if (routers.length > 1) {
    throw new Error(`${definition.slug}: birden fazla yönlendirme sorusu tanımlı`);
  }

  for (const question of questions) {
    const optionKeys = new Set((question.options ?? []).map((entry) => entry.key));

    if (
      (question.type === 'SELECT' || question.type === 'MULTI_SELECT') &&
      optionKeys.size === 0
    ) {
      throw new Error(`${definition.slug}/${question.key}: seçenek listesi boş olamaz`);
    }

    if (optionKeys.size !== (question.options ?? []).length) {
      throw new Error(`${definition.slug}/${question.key}: seçenek anahtarları benzersiz değil`);
    }

    for (const condition of question.conditions ?? []) {
      const source = byKey.get(condition.sourceQuestionKey);

      if (!source) {
        throw new Error(
          `${definition.slug}/${question.key}: koşul kaynağı bu kategoride yok (${condition.sourceQuestionKey})`,
        );
      }

      // The same ordering rule the API enforces, checked here so a wave can
      // never introduce a cycle the visibility pass would have to search for.
      if (source.sortOrder >= question.sortOrder) {
        throw new Error(
          `${definition.slug}/${question.key}: koşul kaynağı (${source.key}) daha önce sıralanmalı`,
        );
      }

      // The same rule the admin endpoint enforces, checked before the first
      // row is written: ALL is a distinction only a multi-answer source can
      // carry.
      if (condition.matchMode === 'ALL' && source.type !== 'MULTI_SELECT') {
        throw new Error(
          `${definition.slug}/${question.key}: ALL eşleşmesi için kaynak soru (${source.key}) MULTI_SELECT olmalı`,
        );
      }

      const sourceOptions = new Set((source.options ?? []).map((entry) => entry.key));
      for (const value of condition.expectedValues) {
        if (!sourceOptions.has(value)) {
          throw new Error(
            `${definition.slug}/${question.key}: ${source.key} sorusunda ${value} seçeneği yok`,
          );
        }
      }
    }

    for (const rule of question.routerRules ?? []) {
      if (!optionKeys.has(rule.optionKey)) {
        throw new Error(
          `${definition.slug}/${question.key}: ${rule.optionKey} seçeneği tanımlı değil`,
        );
      }
    }
  }
}
