import { describe, expect, it } from 'vitest';
import signalCases from '../../../packages/shared/quality-signal-cases.json';
import type { Question, QuestionSystemField, QuestionType } from '../lib/api';
import { estimateRequestQuality, formQualitySignals } from '../lib/request-quality-estimate';
import { qualityTipText } from '../lib/formatters';

/**
 * QUALITY-SCORE-001 — the form's estimate reads the form the way the API reads
 * the stored request. The arithmetic itself is the shared model's and is held
 * to the shared score cases in `packages/shared/src/quality-score.spec.ts`;
 * these are the shared *signal* cases, which the API runs through
 * `resolveQualitySignals` in `apps/api/test/request-quality-score.spec.ts`.
 */
function toQuestion(raw: (typeof signalCases.scenarios)[number]['questions'][number]): Question {
  return {
    id: raw.id,
    key: raw.key,
    label: raw.key,
    helpText: null,
    type: raw.type as QuestionType,
    isRequired: raw.isRequired,
    options: null,
    systemField: (raw.systemField ?? null) as QuestionSystemField | null,
    sortOrder: raw.sortOrder,
    conditions: raw.conditions.map((condition) => ({
      sourceQuestionKey: condition.source,
      sourceQuestionLabel: condition.source,
      expectedValues: condition.expectedValues,
    })),
  };
}

describe('form quality signals — shared cases', () => {
  it.each(signalCases.scenarios)('$name', ({ questions, answers, fields, expected }) => {
    const signals = formQualitySignals(
      fields,
      questions.map(toQuestion),
      answers as Record<string, string | string[]>,
    );
    expect(signals).toEqual({ description: fields.description, ...expected });
  });
});

describe('form quality estimate', () => {
  const empty = { description: '', budgetMin: '', budgetMax: '', preferredDate: '', urgency: '' };

  it('starts LOW with every tip on an empty form', () => {
    const estimate = estimateRequestQuality(empty, [], {});
    expect(estimate.label).toBe('LOW');
    expect(estimate.tips).toEqual(['DESCRIPTION', 'BUDGET', 'TIMING']);
  });

  it('reaches HIGH with a described job, a budget and dates, and then has nothing to suggest', () => {
    const description =
      'Salon kliması soğutmuyor, dış ünite yüksek ses yapıyor. Cihaz beş yıllık, inverter model; filtreler ' +
      'temizlendi, gaz kaçağından şüpheleniyoruz. Hafta içi akşam saatlerinde evdeyiz, otopark ziyaretçiye açık.';
    const estimate = estimateRequestQuality(
      { description, budgetMin: '1500', budgetMax: '2500', preferredDate: '2026-11-02', urgency: 'FLEXIBLE' },
      [],
      {},
    );
    expect(estimate.label).toBe('HIGH');
    expect(estimate.tips).toEqual([]);
  });

  it('has customer wording for every tip', () => {
    for (const tip of ['DESCRIPTION', 'OPTIONAL_QUESTIONS', 'BUDGET', 'TIMING'] as const) {
      expect(qualityTipText(tip).length).toBeGreaterThan(10);
    }
  });
});
