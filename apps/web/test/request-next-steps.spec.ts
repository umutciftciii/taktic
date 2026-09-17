import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextStepsNote } from '../app/categories/[slug]/next-steps-note';
import {
  NEXT_STEPS_TITLE,
  nextStepsNoteText,
  readMarketplacePublishPolicy,
} from '../lib/request-next-steps';

/**
 * The "Sırada ne var?" note on the marketplace request form.
 *
 * It tells the customer what happens after they send the request, and that
 * depends on one operations switch: with instant publish on, no operator reads
 * the request first, and a sentence that promises a review would be wrong.
 *
 * The switch is read from the API on every page load; here the concern is what
 * the form does with what it got. The rule is fail-closed: only a response that
 * says `true`, in the shape the API documents, produces the instant-publish
 * sentence. Anything else — no response, an error, a body with the wrong shape
 * — is the review sentence, because that is the promise the platform can keep
 * whatever the switch actually says.
 *
 * That the sentence changes when the switch is flipped, on a real page, is
 * `e2e/tests/request-next-steps-note.spec.ts`'s claim.
 */

const REVIEW_SENTENCE =
  'Talebiniz ön incelemeden geçtikten sonra bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';
const INSTANT_SENTENCE =
  'Talebiniz bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the next-steps sentence', () => {
  it('promises a review while instant publish is off', () => {
    expect(nextStepsNoteText(false)).toBe(REVIEW_SENTENCE);
  });

  it('promises no review while instant publish is on', () => {
    expect(nextStepsNoteText(true)).toBe(INSTANT_SENTENCE);
  });

  it('keeps its title either way', () => {
    expect(NEXT_STEPS_TITLE).toBe('Sırada ne var?');
  });
});

describe('reading the publish policy the API answered', () => {
  it('is on only for the documented shape with a literal true', () => {
    expect(readMarketplacePublishPolicy({ autoPublishEnabled: true })).toBe(true);
  });

  it('is off for a literal false', () => {
    expect(readMarketplacePublishPolicy({ autoPublishEnabled: false })).toBe(false);
  });

  it.each([
    ['no body', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a string that spells true', { autoPublishEnabled: 'true' }],
    ['a number', { autoPublishEnabled: 1 }],
    ['a bare boolean', true],
    ['a different field', { enabled: true }],
    ['an array', [true]],
  ])('is off for %s', (_label, body) => {
    expect(readMarketplacePublishPolicy(body)).toBe(false);
  });
});

describe('the note as rendered', () => {
  it('is the rail note with the review sentence when instant publish is off', () => {
    const markup = renderToStaticMarkup(createElement(NextStepsNote, { autoPublishEnabled: false }));
    expect(markup).toMatch(/^<div [^>]*class="rail-note"/);
    expect(markup).toContain('data-testid="request-next-steps"');
    expect(markup).toContain('data-auto-publish="off"');
    expect(markup).toContain('<strong>Sırada ne var?</strong>');
    expect(textOf(markup)).toBe(`Sırada ne var? ${REVIEW_SENTENCE}`);
  });

  it('is the rail note with the instant sentence when instant publish is on', () => {
    const markup = renderToStaticMarkup(createElement(NextStepsNote, { autoPublishEnabled: true }));
    expect(markup).toContain('data-auto-publish="on"');
    expect(textOf(markup)).toBe(`Sırada ne var? ${INSTANT_SENTENCE}`);
    expect(markup).not.toContain('ön inceleme');
  });

  it('falls back to the review sentence when told nothing', () => {
    const markup = renderToStaticMarkup(createElement(NextStepsNote, {}));
    expect(markup).toContain('data-auto-publish="off"');
    expect(textOf(markup)).toBe(`Sırada ne var? ${REVIEW_SENTENCE}`);
  });
});
