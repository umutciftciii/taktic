import { describe, expect, it } from 'vitest';
import type { Question, QuestionCondition } from '../lib/api';
import {
  decodeRouterSelections,
  encodeRouterSelections,
  visibleQuestions,
} from '../lib/request-flow';

/**
 * How a routed flow's steps survive the trip between screens.
 *
 * This runs on the server: the page reads the parameter and the submit action
 * decodes it before posting. What matters is that a parameter somebody edited
 * by hand degrades to "no routing yet" rather than to a crash or to a step the
 * customer never took — the API re-walks every step it is given, so a decoded
 * value is a claim to be checked, never an instruction.
 */
describe('router selection encoding', () => {
  it('round-trips the steps in order', () => {
    const selections = [
      { questionKey: 'alan', optionKey: 'beyaz_esya' },
      { questionKey: 'cihaz', optionKey: 'camasir' },
    ];

    expect(decodeRouterSelections(encodeRouterSelections(selections))).toEqual(selections);
  });

  it('reads an absent parameter as no routing', () => {
    expect(decodeRouterSelections(undefined)).toEqual([]);
    expect(decodeRouterSelections(null)).toEqual([]);
    expect(decodeRouterSelections('')).toEqual([]);
  });

  it('reads malformed JSON as no routing rather than throwing', () => {
    expect(decodeRouterSelections('{oops')).toEqual([]);
    expect(decodeRouterSelections('"a string"')).toEqual([]);
    expect(decodeRouterSelections('{"questionKey":"cihaz"}')).toEqual([]);
  });

  it('drops entries that are not a question/option pair', () => {
    const raw = JSON.stringify([
      ['cihaz', 'camasir'],
      ['sadece-bir-eleman'],
      [42, 'camasir'],
      ['cihaz', null],
      { questionKey: 'cihaz', optionKey: 'bulasik' },
    ]);

    expect(decodeRouterSelections(raw)).toEqual([{ questionKey: 'cihaz', optionKey: 'camasir' }]);
  });
});

/**
 * The browser's copy of the visibility rule.
 *
 * It decides what the customer sees, and the API re-derives the same answer
 * before writing anything — so what these cases guard is that the two agree.
 * Where they would not, the customer meets a validation error on a question
 * that was never on screen, which is the failure this suite exists to prevent.
 */
describe('conditional question visibility', () => {
  function question(overrides: Partial<Question> & Pick<Question, 'key' | 'sortOrder'>): Question {
    return {
      id: overrides.key,
      label: overrides.key,
      helpText: null,
      type: 'SELECT',
      isRequired: false,
      options: null,
      ...overrides,
    };
  }

  const source = question({ key: 'isler', sortOrder: 10, type: 'MULTI_SELECT' });

  function dependent(condition: Partial<QuestionCondition>): Question {
    return question({
      key: 'detay',
      sortOrder: 20,
      conditions: [
        {
          sourceQuestionKey: 'isler',
          sourceQuestionLabel: 'İşler',
          expectedValues: ['tesisat', 'dolap'],
          ...condition,
        },
      ],
    });
  }

  const shownKeys = (questions: Question[], answers: Record<string, string | string[]>) =>
    visibleQuestions(questions, answers).map((entry) => entry.key);

  it('treats a rule with no mode as ANY, which is what every legacy rule means', () => {
    const questions = [source, dependent({})];

    expect(shownKeys(questions, { isler: ['tesisat'] })).toEqual(['isler', 'detay']);
    expect(shownKeys(questions, { isler: ['kapi'] })).toEqual(['isler']);
  });

  it('shows an ANY question on one expected answer and hides it on none', () => {
    const questions = [source, dependent({ matchMode: 'ANY' })];

    expect(shownKeys(questions, { isler: ['dolap', 'kapi'] })).toEqual(['isler', 'detay']);
    expect(shownKeys(questions, { isler: [] })).toEqual(['isler']);
  });

  it('shows an ALL question only once every expected answer is chosen', () => {
    const questions = [source, dependent({ matchMode: 'ALL' })];

    expect(shownKeys(questions, { isler: ['tesisat'] })).toEqual(['isler']);
    expect(shownKeys(questions, { isler: ['tesisat', 'dolap'] })).toEqual(['isler', 'detay']);
    // Extra choices do not spoil it: the rule is about what is present.
    expect(shownKeys(questions, { isler: ['kapi', 'dolap', 'tesisat'] })).toEqual([
      'isler',
      'detay',
    ]);
  });
});
