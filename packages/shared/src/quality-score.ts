import config from '../quality-score.json';

/**
 * QUALITY-SCORE-001 — the request quality model, for the web form's live
 * estimate.
 *
 * This is the second copy of the arithmetic, on purpose: the API compiles to
 * CommonJS and cannot load this package's TypeScript at runtime, so it keeps
 * its own (`apps/api/src/modules/service-requests/request-quality.ts`). Both
 * read every number from `packages/shared/quality-score.json`, and both are
 * held to the hand-worked results in `packages/shared/quality-score-cases.json`
 * — that file, not either implementation, is what they must agree with.
 *
 * The estimate on the form is what the API will compute from the same inputs;
 * the customer sees its label and tips, never the number.
 */
export type QualityLabel = 'LOW' | 'MEDIUM' | 'HIGH';

export type QualityComponentKey = 'descriptionDepth' | 'optionalAnswers' | 'budget' | 'timing';

export type QualityComponent = {
  points: number;
  max: number;
  passed: boolean;
  applicable: boolean;
};

export type QualityTip = 'DESCRIPTION' | 'OPTIONAL_QUESTIONS' | 'BUDGET' | 'TIMING';

/** Everything the score reads, already resolved from the form. */
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
  score: number;
  label: QualityLabel;
  meaningfulWords: number;
  breakdown: Record<QualityComponentKey, QualityComponent>;
  tips: QualityTip[];
};

const vowels = new Set([...config.description.vowels]);
const stopWords = new Set(config.description.stopWords);

/** See the API's copy for the rules; they are the same rules. */
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

  let optionalAnswers: QualityComponent = notApplicable();
  if (signals.optionalVisible > 0) {
    const max =
      signals.optionalVisible >= config.optionalAnswers.largeSetMinQuestions
        ? config.optionalAnswers.largeSetMax
        : config.optionalAnswers.smallSetMax;
    optionalAnswers = scored(Math.round((max * signals.optionalAnswered) / signals.optionalVisible), max);
  }

  const breakdown: Record<QualityComponentKey, QualityComponent> = {
    descriptionDepth: scored(descriptionPoints, descriptionMax),
    optionalAnswers,
    budget: signals.budgetRequired
      ? notApplicable()
      : scored(signals.hasBudget ? config.budget.max : 0, config.budget.max),
    timing: signals.datesRequired
      ? notApplicable()
      : scored(
          signals.hasDates ? config.timing.max : signals.hasUrgency ? config.timing.urgencyOnlyPoints : 0,
          config.timing.max,
        ),
  };

  const applicable = Object.values(breakdown).filter((component) => component.applicable);
  const max = applicable.reduce((total, component) => total + component.max, 0);
  const earned = applicable.reduce((total, component) => total + component.points, 0);
  const score = Math.round((100 * earned) / max);

  return {
    score,
    label: labelForScore(score, meaningfulWords),
    meaningfulWords,
    breakdown,
    tips: TIP_ORDER.filter(([key]) => breakdown[key].applicable && breakdown[key].points < breakdown[key].max).map(
      ([, tip]) => tip,
    ),
  };
}

const TIP_ORDER: Array<[QualityComponentKey, QualityTip]> = [
  ['descriptionDepth', 'DESCRIPTION'],
  ['optionalAnswers', 'OPTIONAL_QUESTIONS'],
  ['budget', 'BUDGET'],
  ['timing', 'TIMING'],
];

function labelForScore(score: number, meaningfulWords: number): QualityLabel {
  if (meaningfulWords < config.labels.lowCapBelowWords) {
    return 'LOW';
  }
  if (score >= config.labels.highMin) {
    return 'HIGH';
  }
  if (score >= config.labels.mediumMin) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function scored(points: number, max: number): QualityComponent {
  return { points, max, passed: points === max, applicable: true };
}

function notApplicable(): QualityComponent {
  return { points: 0, max: 0, passed: false, applicable: false };
}
