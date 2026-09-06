import { describe, expect, it } from 'vitest';
import { heroHeadlineLines, heroHeadlineText } from '../lib/hero-headline';

/**
 * The slogan the home page opens with, and the one thing the accent is for.
 *
 * The heading is assembled from segments so that two words can be coloured, and
 * that is exactly where a heading like this goes wrong: a stray space around a
 * highlighted word, or a third word quietly picking up the accent because it
 * read well to somebody. Both are asserted here on the data the heading is
 * built from, which is the whole reason it is data.
 *
 * That the three lines fit a 320px screen and that the accent really is the
 * site's red are browser claims, and `e2e/tests/landing-hero.spec.ts` makes
 * them in a browser.
 */
const SENTENCES = [
  'İhtiyacını tarif et.',
  'Tak diye teklif al.',
  'Tick diye işini hallet.',
];

/**
 * The wordings this replaced, both of them. The middle sentence was once "Tak
 * diye doğru ustadan teklif al." — half again as long as the other two, which
 * made the heading a short line, a wrapped line and a short line rather than
 * the three it is meant to be.
 */
const RETIRED = ['Doğru usta sana teklif versin', 'doğru ustadan teklif al'];

describe('the hero headline', () => {
  it('is the three sentences of the slogan, one per line', () => {
    expect(heroHeadlineLines.map((line) => line.map((segment) => segment.text).join(''))).toEqual(
      SENTENCES,
    );
  });

  it('reads as one uninterrupted run of text', () => {
    // What a screen reader announces: the segments and lines are only layout.
    expect(heroHeadlineText()).toBe(SENTENCES.join(' '));
  });

  it('accents the two brand words and nothing else', () => {
    const accented = heroHeadlineLines
      .flatMap((line) => line)
      .filter((segment) => segment.accent)
      .map((segment) => segment.text);

    expect(accented).toEqual(['Tak', 'Tick']);
  });

  it('keeps the accented words whole, with their spacing outside them', () => {
    // A leading or trailing space inside the coloured span is invisible until
    // the accent is a background rather than a colour, and then it is a bug.
    for (const segment of heroHeadlineLines.flatMap((line) => line)) {
      if (!segment.accent) continue;
      expect(segment.text).toBe(segment.text.trim());
    }
  });

  it('has retired every previous wording', () => {
    for (const wording of RETIRED) {
      expect(heroHeadlineText()).not.toContain(wording);
    }
  });

  it('keeps the three sentences within a line of each other in length', () => {
    // Not a style preference: the heading is 64px on a desktop, so a sentence
    // much longer than the other two wraps and the slogan stops being three
    // lines. Twenty-four characters is what the column fits at that size.
    for (const sentence of SENTENCES) {
      expect(sentence.length, `"${sentence}" is too long to hold its own line`).toBeLessThanOrEqual(
        24,
      );
    }
  });
});
