/**
 * The slogan at the top of the home page, as the pieces its heading renders.
 *
 * The brand is the sound of the thing working: "tak" is the offer landing,
 * "tick" is the job done. Only those two words carry the accent colour, so the
 * heading has to be built out of parts rather than written as a single string —
 * and once it is data rather than markup, what the heading says and which words
 * are highlighted can be asserted without a browser.
 *
 * Two rules hold this together, and `test/hero-headline.spec.ts` states both:
 * concatenating the segments of a line gives that line verbatim, and the only
 * accented segments in the whole heading are "Tak" and "Tick". The first is
 * what keeps the heading readable to a screen reader — the pieces are spans
 * inside one `<h1>`, so a reader runs them together into exactly the sentences
 * below, with the accent adding colour and nothing else.
 */
export type HeroHeadlineSegment = {
  text: string;
  /** Rendered in the site's accent red. Reserved for the two brand words. */
  accent?: true;
};

/**
 * One entry per line of the slogan. The lines are separate blocks so each
 * sentence starts on its own line on a wide screen; on a narrow one each is
 * still free to wrap wherever it has to.
 */
export const heroHeadlineLines: readonly (readonly HeroHeadlineSegment[])[] = [
  [{ text: 'İhtiyacını tarif et.' }],
  [{ text: 'Tak', accent: true }, { text: ' diye doğru ustadan teklif al.' }],
  [{ text: 'Tick', accent: true }, { text: ' diye işini hallet.' }],
];

/** The slogan as one run of text, the way it is read out rather than laid out. */
export function heroHeadlineText(): string {
  return heroHeadlineLines
    .map((line) => line.map((segment) => segment.text).join(''))
    .join(' ');
}
