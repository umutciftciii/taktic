import config from '@taktic/shared/quality-score.json';
import { ServiceRequestQuestionSystemField } from '@prisma/client';
import {
  resolveVisibleQuestionIds,
  type VisibilityQuestion,
} from '../questions/question-visibility';

/**
 * QUALITY-SCORE-001 — how much a request tells the business that has to price
 * it, as a number from 0 to 100 and a label.
 *
 * What it does not measure is just as deliberate. Nothing the form makes
 * mandatory earns a point — the phone, the name, the city and district, an
 * on-site neighbourhood, a required answer — because a value every request
 * must carry cannot tell two requests apart. The access note is not scored
 * either, and the delivery mode is not an input at all: an ON_SITE and a
 * REMOTE request with the same content get the same score.
 *
 * Four components remain, and a component that cannot apply to this request
 * leaves the denominator rather than counting as missed:
 *
 * - description depth (40): meaningful distinct words, linear up to 25;
 * - optional category questions (10 with one or two visible, 20 with three or
 *   more): the share of the *visible* ones answered — a question a condition
 *   hid was never the customer's to answer;
 * - budget (15), unless the category makes the budget required;
 * - timing (15; 8 for an urgency without dates), unless the category makes the
 *   dates required.
 *
 * Every number lives in `packages/shared/quality-score.json`. The web form's
 * estimate reads the same file and is held to the same results by the shared
 * cases file; this module is the API's copy of the arithmetic because the API
 * cannot load the package's TypeScript at runtime (see `common/contact-detection.ts`).
 */
export const QUALITY_SCORE_VERSION: number = config.version;

/** What a request written before this model carries in `qualityScoreVersion`. */
export const LEGACY_QUALITY_SCORE_VERSION = 1;

/** The refusal of an admin recalculation on a row the backfill has not moved. */
export const QUALITY_SCORE_BACKFILL_PENDING_CODE = 'QUALITY_SCORE_BACKFILL_PENDING';

export type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

export type QualityComponentKey = 'descriptionDepth' | 'optionalAnswers' | 'budget' | 'timing';

/**
 * One row of the breakdown. `points`, `max` and `passed` keep the shape every
 * screen already renders; `applicable: false` is a row that left the
 * denominator, shown as "not applicable" rather than as a miss. The remaining
 * fields say why a row scored what it did, so the number can be explained
 * without re-running anything.
 */
export type QualityComponent = {
  points: number;
  max: number;
  /** Full marks on an applicable row. */
  passed: boolean;
  applicable: boolean;
  /** descriptionDepth: the meaningful distinct words counted. */
  meaningfulWords?: number;
  /** optionalAnswers: visible optional questions, and how many were answered. */
  visible?: number;
  answered?: number;
  /** timing: what earned the points. */
  basis?: 'DATES' | 'URGENCY' | 'NONE';
  notApplicableReason?: 'REQUIRED_FIELD' | 'NO_VISIBLE_OPTIONAL_QUESTIONS';
};

export type QualityBreakdown = Record<QualityComponentKey, QualityComponent>;

/** Everything the score reads, already resolved from the request and its form. */
export type RequestQualitySignals = {
  description: string | null;
  hasBudget: boolean;
  hasDates: boolean;
  hasUrgency: boolean;
  budgetRequired: boolean;
  datesRequired: boolean;
  optionalVisible: number;
  optionalAnswered: number;
};

export type RequestQualityResult = {
  version: number;
  score: number;
  label: QualityLabel;
  breakdown: QualityBreakdown;
};

const vowels = new Set([...config.description.vowels]);
const stopWords = new Set(config.description.stopWords);

/**
 * The distinct words in a description that carry meaning.
 *
 * NFC, then Turkish lower case (so "IŞIK" and "ışık" are one word and "İ" is
 * not "i̇"), split on anything that is not a letter or a digit. A word counts
 * when it is 3–20 characters long, has a vowel and a letter that is not one,
 * and is not on the short filler list. Repeats count once.
 *
 * What this stops: repetition, digit runs, keyboard rows without a vowel
 * ("xyz", "zzz"), one enormous token, greetings and filler. What it does not:
 * a three-letter mash that happens to contain a vowel ("asd"). That is left to
 * moderation on purpose — no simple deterministic rule tells it from a word.
 */
export function countMeaningfulWords(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }

  const words = new Set<string>();
  for (const token of text.normalize('NFC').toLocaleLowerCase('tr-TR').split(/[^\p{L}\p{N}]+/u)) {
    const letters = [...token];
    if (letters.length < config.description.minWordLength || letters.length > config.description.maxWordLength) {
      continue;
    }
    if (!letters.some((letter) => vowels.has(letter))) {
      continue;
    }
    if (!letters.some((letter) => /\p{L}/u.test(letter) && !vowels.has(letter))) {
      continue;
    }
    if (stopWords.has(token)) {
      continue;
    }
    words.add(token);
  }

  return words.size;
}

export function scoreRequestQuality(signals: RequestQualitySignals): RequestQualityResult {
  const meaningfulWords = countMeaningfulWords(signals.description);
  const descriptionMax = config.description.max;
  const descriptionPoints = Math.min(
    descriptionMax,
    Math.round((descriptionMax * meaningfulWords) / config.description.saturationWords),
  );

  const breakdown: QualityBreakdown = {
    descriptionDepth: {
      ...scored(descriptionPoints, descriptionMax),
      meaningfulWords,
    },
    optionalAnswers: optionalAnswersComponent(signals.optionalVisible, signals.optionalAnswered),
    budget: signals.budgetRequired
      ? notApplicable('REQUIRED_FIELD')
      : scored(signals.hasBudget ? config.budget.max : 0, config.budget.max),
    timing: signals.datesRequired
      ? notApplicable('REQUIRED_FIELD')
      : timingComponent(signals.hasDates, signals.hasUrgency),
  };

  // The description row is always applicable, so the denominator is never 0.
  const applicable = Object.values(breakdown).filter((component) => component.applicable);
  const max = applicable.reduce((total, component) => total + component.max, 0);
  const earned = applicable.reduce((total, component) => total + component.points, 0);
  const score = Math.round((100 * earned) / max);

  return {
    version: QUALITY_SCORE_VERSION,
    score,
    label: labelForScore(score, meaningfulWords),
    breakdown,
  };
}

/**
 * The label of a stored request, whichever model wrote it.
 *
 * A row written before this model keeps the thresholds it was scored under
 * (80/50) until the backfill rewrites it; mixing the two scales under one set
 * of thresholds would call most legacy rows HIGH for numbers this model would
 * never give. A current row is read with the current thresholds and the
 * description gate: fewer than five meaningful words caps the label at LOW
 * whatever the number says — the number itself is kept.
 */
export function requestQualityLabel(request: {
  qualityScore: number;
  qualityScoreVersion: number;
  qualityScoreBreakdown: unknown;
}): QualityLabel {
  if (request.qualityScoreVersion < QUALITY_SCORE_VERSION) {
    return thresholdLabel(request.qualityScore, config.legacyLabels.highMin, config.legacyLabels.mediumMin);
  }

  return labelForScore(request.qualityScore, storedMeaningfulWords(request.qualityScoreBreakdown));
}

/**
 * What the customer could add, one code per component that fell short — the
 * customer's side of the breakdown (QUALITY-SCORE-001): they see the label and
 * these, never the number or the working. In component order, so the list
 * reads the same on every screen. A row written by the original model has no
 * component to read and yields none.
 */
export type QualityTip = 'DESCRIPTION' | 'OPTIONAL_QUESTIONS' | 'BUDGET' | 'TIMING';

const TIP_BY_COMPONENT: Array<[QualityComponentKey, QualityTip]> = [
  ['descriptionDepth', 'DESCRIPTION'],
  ['optionalAnswers', 'OPTIONAL_QUESTIONS'],
  ['budget', 'BUDGET'],
  ['timing', 'TIMING'],
];

export function qualityTips(request: { qualityScoreVersion: number; qualityScoreBreakdown: unknown }): QualityTip[] {
  if (request.qualityScoreVersion < QUALITY_SCORE_VERSION) {
    return [];
  }

  const breakdown =
    request.qualityScoreBreakdown && typeof request.qualityScoreBreakdown === 'object'
      ? (request.qualityScoreBreakdown as Record<string, Partial<QualityComponent> | undefined>)
      : {};

  return TIP_BY_COMPONENT.filter(([key]) => {
    const component = breakdown[key];
    return (
      component !== undefined &&
      component.applicable !== false &&
      typeof component.points === 'number' &&
      typeof component.max === 'number' &&
      component.points < component.max
    );
  }).map(([, tip]) => tip);
}

const LABEL_RANK: Record<QualityLabel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Whether `label` is `minimum` or better — what an "at least" filter asks. */
export function qualityLabelAtLeast(label: QualityLabel, minimum: QualityLabel): boolean {
  return LABEL_RANK[label] >= LABEL_RANK[minimum];
}

/**
 * The signals of a request, read from its fields and its category's form.
 *
 * `questions` is the category's active form, bound questions included:
 * visibility is resolved over the whole form exactly as `validateAnswers`
 * resolves it, so a question hidden at submission is hidden here too. Only
 * then are the bound questions set aside — their fields are scored by name —
 * and the visible optional ones counted. A bound BUDGET or PREFERRED_DATE
 * question that is required *and visible* makes that field mandatory, which
 * takes its component out of the denominator.
 *
 * `answers` may hold rows for questions outside this form (a routed request's
 * router steps); they match no question here and are ignored.
 */
export function resolveQualitySignals(input: {
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  preferredDate: Date | string | null;
  urgency: string | null;
  questions: Array<VisibilityQuestion & { isRequired: boolean; systemField: ServiceRequestQuestionSystemField | null }>;
  answers: Array<{ questionId: string; value: unknown }>;
}): RequestQualitySignals {
  const answered = new Map<string, unknown>(
    input.answers.filter((answer) => hasAnswerValue(answer.value)).map((answer) => [answer.questionId, answer.value]),
  );
  const visibleIds = resolveVisibleQuestionIds(input.questions, answered);
  const visible = input.questions.filter((question) => visibleIds.has(question.id));
  const requiredField = (field: ServiceRequestQuestionSystemField) =>
    visible.some((question) => question.systemField === field && question.isRequired);
  const optional = visible.filter((question) => question.systemField === null && !question.isRequired);

  return {
    description: input.description,
    hasBudget: input.budgetMin !== null || input.budgetMax !== null,
    hasDates: Boolean(input.preferredDate),
    hasUrgency: Boolean(input.urgency?.trim()),
    budgetRequired: requiredField(ServiceRequestQuestionSystemField.BUDGET),
    datesRequired: requiredField(ServiceRequestQuestionSystemField.PREFERRED_DATE),
    optionalVisible: optional.length,
    optionalAnswered: optional.filter((question) => answered.has(question.id)).length,
  };
}

export function hasAnswerValue(value: unknown) {
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

function optionalAnswersComponent(visible: number, answered: number): QualityComponent {
  if (visible === 0) {
    return notApplicable('NO_VISIBLE_OPTIONAL_QUESTIONS');
  }

  const max =
    visible >= config.optionalAnswers.largeSetMinQuestions
      ? config.optionalAnswers.largeSetMax
      : config.optionalAnswers.smallSetMax;
  return { ...scored(Math.round((max * answered) / visible), max), visible, answered };
}

function timingComponent(hasDates: boolean, hasUrgency: boolean): QualityComponent {
  const max = config.timing.max;
  if (hasDates) {
    return { ...scored(max, max), basis: 'DATES' };
  }
  if (hasUrgency) {
    return { ...scored(config.timing.urgencyOnlyPoints, max), basis: 'URGENCY' };
  }
  return { ...scored(0, max), basis: 'NONE' };
}

function scored(points: number, max: number): QualityComponent {
  return { points, max, passed: points === max, applicable: true };
}

function notApplicable(reason: QualityComponent['notApplicableReason']): QualityComponent {
  return { points: 0, max: 0, passed: false, applicable: false, notApplicableReason: reason };
}

function labelForScore(score: number, meaningfulWords: number): QualityLabel {
  if (meaningfulWords < config.labels.lowCapBelowWords) {
    return 'LOW';
  }

  return thresholdLabel(score, config.labels.highMin, config.labels.mediumMin);
}

function thresholdLabel(score: number, highMin: number, mediumMin: number): QualityLabel {
  if (score >= highMin) {
    return 'HIGH';
  }

  if (score >= mediumMin) {
    return 'MEDIUM';
  }

  return 'LOW';
}

/**
 * The word count a current row was scored with. A row whose breakdown does
 * not carry one reads as 0 — capped at LOW — rather than as an uncapped
 * label: an unexplained number is not a reason to trust it.
 */
function storedMeaningfulWords(breakdown: unknown): number {
  if (breakdown && typeof breakdown === 'object') {
    const description = (breakdown as Record<string, unknown>).descriptionDepth;
    if (description && typeof description === 'object') {
      const words = (description as Record<string, unknown>).meaningfulWords;
      if (typeof words === 'number' && Number.isFinite(words)) {
        return words;
      }
    }
  }

  return 0;
}
