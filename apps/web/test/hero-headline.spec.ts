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
  'Tak diye doğru ustadan teklif al.',
  'Tick diye işini hallet.',
];

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

  it('has retired the previous slogan', () => {
    expect(heroHeadlineText()).not.toContain('Doğru usta sana teklif versin');
  });
});
