import { describe, expect, it } from 'vitest';
import { orderedQualityBreakdown } from '../lib/formatters';

/**
 * QUALITY-SCORE-001: the breakdown is stored as jsonb, which hands the keys
 * back shortest first. The screen keeps the model's own order.
 */
describe('quality breakdown order', () => {
  it('shows the four components in model order whatever order the API sent', () => {
    const fromJsonb = { budget: 1, timing: 2, optionalAnswers: 3, descriptionDepth: 4 };
    expect(orderedQualityBreakdown(fromJsonb).map(([key]) => key)).toEqual([
      'descriptionDepth',
      'optionalAnswers',
      'budget',
      'timing',
    ]);
  });

  it('keeps an original-model breakdown in its own order and puts unknown rows last', () => {
    const legacy = { urgencyPresent: 1, newerRow: 2, phonePresent: 3, namePresent: 4 };
    expect(orderedQualityBreakdown(legacy).map(([key]) => key)).toEqual([
      'phonePresent',
      'namePresent',
      'urgencyPresent',
      'newerRow',
    ]);
  });
});
