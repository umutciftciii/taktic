import type { Question, QuestionSystemField, RouterSelection } from './api';

/**
 * The browser's copy of two rules the API owns: which questions are on screen,
 * and which built-in field a question is standing in for.
 *
 * It exists so the customer sees the right form, not so the server can trust
 * it. Everything decided here is re-derived server-side from the stored rules
 * before a request is written — a browser that skipped a condition, invented
 * one, or answered a hidden question changes what it renders and nothing else.
 */

/**
 * Whether a question is visible given the answers so far.
 *
 * Conditions are ANDed, a SELECT answer matches by equality and a MULTI_SELECT
 * one by intersection, and a question whose source is itself hidden is hidden
 * too. Deliberately the same shape as resolveVisibleQuestionIds in the API — if
 * these two ever disagree, the API wins and the customer gets a validation
 * error, which is the safe direction for them to disagree in.
 */
export function visibleQuestions(
  questions: readonly Question[],
  answers: Readonly<Record<string, string | string[]>>,
): Question[] {
  const ordered = [...questions].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
  );

  const visibleKeys = new Set<string>();
  const result: Question[] = [];

  for (const question of ordered) {
    const shown = (question.conditions ?? []).every((condition) => {
      if (!visibleKeys.has(condition.sourceQuestionKey)) {
        return false;
      }

      const answer = answers[condition.sourceQuestionKey];
      if (Array.isArray(answer)) {
        return answer.some((value) => condition.expectedValues.includes(value));
      }

      return typeof answer === 'string' && answer !== ''
        ? condition.expectedValues.includes(answer)
        : false;
    });

    if (shown) {
      visibleKeys.add(question.key);
      result.push(question);
    }
  }

  return result;
}

/** The visible question bound to a given request field, when there is one. */
export function boundQuestion(
  questions: readonly Question[],
  field: QuestionSystemField,
): Question | undefined {
  return questions.find((question) => question.systemField === field);
}

/**
 * How a routed flow's steps travel between screens.
 *
 * A JSON array in one query parameter, on purpose: it is readable in the
 * address bar, survives a refresh and a shared link, and carries nothing worth
 * hiding. It is also not authority — the API re-walks every step from the entry
 * category before it writes anything, so a hand-edited parameter produces a
 * refusal, not a request on a category the customer never chose.
 */
export function encodeRouterSelections(selections: readonly RouterSelection[]): string {
  return JSON.stringify(
    selections.map((selection) => [selection.questionKey, selection.optionKey]),
  );
}

export function decodeRouterSelections(raw: string | null | undefined): RouterSelection[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        return [];
      }

      const [questionKey, optionKey] = entry;
      if (typeof questionKey !== 'string' || typeof optionKey !== 'string') {
        return [];
      }

      return [{ questionKey, optionKey }];
    });
  } catch {
    // A malformed parameter means "no routing so far". The entry category is
    // still the one in the URL, so the worst case is a router screen shown
    // again — never a request written against a category nobody picked.
    return [];
  }
}
