import { describe, expect, it } from 'vitest';
import cases from '../quality-score-cases.json';
import { countMeaningfulWords, scoreRequestQuality, type QualityComponentKey } from './quality-score';

/**
 * The web form's copy of the quality model against the shared cases — the same
 * file the API's copy runs in `apps/api/test/request-quality-score.spec.ts`.
 * Both passing is what "the estimate on the form is the score the API will
 * write" means.
 */
const COMPONENTS: QualityComponentKey[] = ['descriptionDepth', 'optionalAnswers', 'budget', 'timing'];

describe('quality model — shared cases (web copy)', () => {
  it.each(cases.words)('counts meaningful words: $name', ({ text, expected }) => {
    expect(countMeaningfulWords(text)).toBe(expected);
  });

  it.each(cases.scores)('scores: $name', ({ signals, expected }) => {
    const result = scoreRequestQuality(signals);

    expect(result.score).toBe(expected.score);
    expect(result.label).toBe(expected.label);
    expect(result.tips).toEqual(expected.tips);
    for (const key of COMPONENTS) {
      const want = expected.points[key as keyof typeof expected.points];
      if (want === null) {
        expect(result.breakdown[key]).toMatchObject({ applicable: false, points: 0, max: 0 });
      } else {
        expect(result.breakdown[key]).toMatchObject({ applicable: true, points: want });
      }
    }
  });
});
