import { Prisma } from '@prisma/client';

/**
 * How a category's question set reaches a client.
 *
 * Conditions travel by the *source question's key*, never by its database id.
 * The key is the stable, category-scoped name the form already speaks — the
 * answers a client posts are keyed by it too — so a client can evaluate a rule
 * without ever being handed an internal identifier, and the admin screens can
 * show a rule as "shown when <question> = <value>" rather than as a row of
 * opaque ids.
 */

export const questionWithRulesInclude = {
  conditions: {
    include: {
      sourceQuestion: { select: { id: true, key: true, label: true, type: true, options: true } },
    },
  },
  routerRules: {
    include: {
      targetCategory: {
        select: { id: true, name: true, slug: true, kind: true, status: true },
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { optionKey: 'asc' }],
  },
} satisfies Prisma.ServiceRequestQuestionInclude;

export type QuestionWithRules = Prisma.ServiceRequestQuestionGetPayload<{
  include: typeof questionWithRulesInclude;
}>;

export type SerializedQuestionCondition = {
  sourceQuestionKey: string;
  sourceQuestionLabel: string;
  expectedValues: string[];
};

/**
 * The router destinations a *client* is allowed to see: the option and the
 * name of the service it leads to. The target's own status never travels —
 * "this option currently goes nowhere" is a 409 at submission time, not a hint
 * on the form.
 */
export type SerializedRouterRule = {
  optionKey: string;
  targetCategoryName: string;
  targetCategorySlug: string;
};

export type SerializeQuestionOptions = {
  /**
   * Whether the destinations of a routing question travel with it.
   *
   * Off for anything a visitor can reach, and that is not tidiness: a router's
   * option may lead to a category that has not been released, and naming it on
   * a public page would announce an unreleased service to anybody who opened
   * the router. The customer does not need it either — they pick an option and
   * the API decides where that goes — so the public payload carries the option
   * labels and stops there.
   *
   * On for the admin screens, which are exactly where somebody has to see and
   * edit the wiring.
   */
  exposeRouterTargets: boolean;
};

export function serializeQuestion(
  question: QuestionWithRules,
  options: SerializeQuestionOptions = { exposeRouterTargets: false },
) {
  const { conditions, routerRules, ...rest } = question;

  return {
    ...rest,
    // Conditions do travel publicly, and have to: the browser evaluates them to
    // decide what to render. They name a question of this same category by its
    // key, so they disclose nothing the customer is not already looking at.
    conditions: conditions.map(
      (condition): SerializedQuestionCondition => ({
        sourceQuestionKey: condition.sourceQuestion.key,
        sourceQuestionLabel: condition.sourceQuestion.label,
        expectedValues: condition.expectedValues,
      }),
    ),
    routerRules: options.exposeRouterTargets
      ? routerRules.map(
          (rule): SerializedRouterRule => ({
            optionKey: rule.optionKey,
            targetCategoryName: rule.targetCategory.name,
            targetCategorySlug: rule.targetCategory.slug,
          }),
        )
      : [],
  };
}
