import { scoreRequestQuality, type RequestQualityResult, type RequestQualitySignals } from '@taktic/shared';
import type { Question } from './api';
import { visibleQuestions } from './request-flow';

/**
 * The form's live quality estimate (QUALITY-SCORE-001).
 *
 * The arithmetic is the shared model's (`@taktic/shared`, held to the same
 * cases file as the API's copy). What is this file's own is reading the form
 * the way the API reads the stored request: visibility over the whole form,
 * bound questions set aside and counted only for "is this field mandatory",
 * and an answer counted when it holds something — the shared signal cases in
 * `packages/shared/quality-signal-cases.json` hold both readers to that.
 */
export type QualityFormFields = {
  description: string;
  budgetMin: string;
  budgetMax: string;
  preferredDate: string;
  urgency: string;
};

export function formQualitySignals(
  fields: QualityFormFields,
  questions: readonly Question[],
  answers: Readonly<Record<string, string | string[]>>,
): RequestQualitySignals {
  const shown = visibleQuestions(questions, answers);
  const requiredField = (field: 'BUDGET' | 'PREFERRED_DATE') =>
    shown.some((question) => question.systemField === field && question.isRequired);
  const optional = shown.filter((question) => !question.systemField && !question.isRequired);

  return {
    description: fields.description,
    hasBudget: Boolean(fields.budgetMin.trim() || fields.budgetMax.trim()),
    hasDates: Boolean(fields.preferredDate.trim()),
    hasUrgency: Boolean(fields.urgency.trim()),
    budgetRequired: requiredField('BUDGET'),
    datesRequired: requiredField('PREFERRED_DATE'),
    optionalVisible: optional.length,
    optionalAnswered: optional.filter((question) => hasAnswer(answers[question.key])).length,
  };
}

export function estimateRequestQuality(
  fields: QualityFormFields,
  questions: readonly Question[],
  answers: Readonly<Record<string, string | string[]>>,
): RequestQualityResult {
  return scoreRequestQuality(formQualitySignals(fields, questions, answers));
}

function hasAnswer(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}
