import { QuestionConditionMatchMode, ServiceRequestQuestionType } from '@prisma/client';

/**
 * Which of a category's questions are actually on screen, given the answers so
 * far — the single definition, shared by the API that validates a submission
 * and by the tests that pin the rule down.
 *
 * The web form evaluates the same rule in the browser to decide what to render,
 * but that copy is a convenience: nothing it concludes is trusted. The API
 * re-derives visibility here from the stored rules and the submitted answers,
 * and refuses an answer to a question this function says is not visible. A
 * client cannot talk its way into an inapplicable question by hiding the
 * condition.
 */

export type VisibilityCondition = {
  sourceQuestionId: string;
  /** One or many. `matchMode` says how the answer is compared against them. */
  expectedValues: string[];
  /**
   * ANY — at least one of the expected values was chosen.
   * ALL — every one of them was.
   *
   * Optional here, and absent means ANY, because that is what every rule stored
   * before the column existed meant. The database default says the same thing;
   * this is the same statement for a caller that builds a condition by hand.
   */
  matchMode?: QuestionConditionMatchMode;
};

export type VisibilityQuestion = {
  id: string;
  key: string;
  type: ServiceRequestQuestionType;
  sortOrder: number;
  conditions: VisibilityCondition[];
};

/**
 * The answers as the customer sent them, keyed by question id. A missing key
 * means "unanswered", which never satisfies a condition.
 */
export type AnswerLookup = Map<string, unknown>;

/**
 * Whether one condition holds.
 *
 * A SELECT answer is a single option key and matches when it is one of the
 * expected values. A MULTI_SELECT answer is a list, and `matchMode` decides how
 * the two lists are compared:
 *
 *   ANY  the lists intersect — "the customer ticked at least one of the things
 *        this question cares about". The default, and what every rule written
 *        before the mode existed meant.
 *   ALL  the answer covers every expected value — "the customer ticked all of
 *        them". Extra choices beyond the expected set do not spoil it; the rule
 *        is about what is present, not about what is absent.
 *
 * Every other answer shape is compared as text, which makes a BOOLEAN source
 * usable ("true"/"false") without a special case. A single value can only
 * satisfy ALL when exactly one value was expected — which is also why the admin
 * endpoint refuses ALL on a source that is not MULTI_SELECT: anywhere else the
 * two modes are the same rule under two names.
 */
export function conditionHolds(condition: VisibilityCondition, answer: unknown): boolean {
  if (condition.expectedValues.length === 0) {
    // A rule that expects nothing can never be satisfied. Writing one is
    // refused at the admin endpoint; treating it as false here means a rule
    // that somehow got stored hides its question rather than showing it
    // unconditionally.
    return false;
  }

  const requireAll = condition.matchMode === QuestionConditionMatchMode.ALL;
  const chosen = toChosenValues(answer);

  if (chosen === null) {
    return false;
  }

  return requireAll
    ? condition.expectedValues.every((value) => chosen.has(value))
    : condition.expectedValues.some((value) => chosen.has(value));
}

/**
 * The answer as a set of chosen option keys, or null when it is not an answer
 * a condition can read at all.
 *
 * Collapsing every shape to one set is what lets ANY and ALL be a single line
 * each rather than a matrix of type × mode.
 */
function toChosenValues(answer: unknown): Set<string> | null {
  if (Array.isArray(answer)) {
    return new Set(answer.filter((item): item is string => typeof item === 'string'));
  }

  if (typeof answer === 'string') {
    return new Set([answer]);
  }

  if (typeof answer === 'boolean' || typeof answer === 'number') {
    return new Set([String(answer)]);
  }

  return null;
}

/**
 * The ids of every question that is on screen.
 *
 * Conditions on one question are combined with AND: a question shown only for
 * "tiled bathroom" *and* "materials included" needs both. A question whose
 * source is itself hidden is hidden too — otherwise a two-level rule would
 * light up from a stale answer to a question nobody could see.
 *
 * Evaluation is a single pass in `sortOrder`, which is sound because the admin
 * endpoint refuses a condition whose source does not sort before its target.
 * That ordering constraint is what makes the dependency graph acyclic by
 * construction; there is no cycle search here because there can be no cycle.
 */
export function resolveVisibleQuestionIds(
  questions: readonly VisibilityQuestion[],
  answers: AnswerLookup,
): Set<string> {
  const ordered = [...questions].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
  );

  const visible = new Set<string>();

  for (const question of ordered) {
    const shown = question.conditions.every(
      (condition) =>
        visible.has(condition.sourceQuestionId) &&
        conditionHolds(condition, answers.get(condition.sourceQuestionId)),
    );

    if (shown) {
      visible.add(question.id);
    }
  }

  return visible;
}
