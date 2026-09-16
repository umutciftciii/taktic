import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepCard, steps } from '../app/landing-steps';

/**
 * The "3 adımda teklif al" cards on the home page.
 *
 * Each card used to stack its number, its icon and its title as three
 * unrelated rows, so across three cards the icons lined up into a strip of
 * their own that belonged to no step. The markup now groups the three into
 * one heading block per card, and that grouping — not the CSS that draws it —
 * is what is asserted here. That the block also lines up in a browser at
 * 320px and 1440px is `e2e/tests/landing-steps.spec.ts`'s claim.
 */

/** Where a substring first appears in the markup, failing if it does not. */
function position(markup: string, needle: string): number {
  const index = markup.indexOf(needle);
  expect(index, `expected the markup to contain ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** `<tag ... class="a b c" ...>` → the element's class list. */
function classesOf(markup: string, tag: string, className: string): string[] {
  const match = markup.match(new RegExp(`<${tag}[^>]*class="([^"]*\\b${className}\\b[^"]*)"`));
  expect(match, `expected a <${tag}> carrying .${className}`).not.toBeNull();
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('the three request steps', () => {
  it('are numbered one to three, in order, with the wording the page always had', () => {
    expect(steps.map((step) => step.n)).toEqual([1, 2, 3]);
    expect(steps.map((step) => step.title)).toEqual([
      'İhtiyacını anlat',
      'Teklifleri karşılaştır',
      'Uygun olanı seç',
    ]);
    for (const step of steps) {
      expect(step.desc.length, `step ${step.n} has a description`).toBeGreaterThan(20);
    }
  });

  it('give each step its own icon', () => {
    const icons = new Set(steps.map((step) => step.Icon));
    expect(icons.size).toBe(steps.length);
  });
});

describe('a step card', () => {
  const [first] = steps;
  const markup = renderToStaticMarkup(createElement(StepCard, { step: first! }));

  it('is an article with one heading block holding the number, the icon and the title', () => {
    expect(markup.startsWith('<article')).toBe(true);
    expect(markup.match(/class="lp-step-head"/g)).toHaveLength(1);

    const head = position(markup, 'class="lp-step-head"');
    const headEnd = position(markup, '</h3>');
    const num = position(markup, 'class="lp-step-num"');
    const icon = position(markup, 'class="lp-step-icon"');
    const title = position(markup, '<h3 class="lp-step-title"');
    const desc = position(markup, 'class="lp-step-desc"');

    // Number, icon and title all sit inside the head, in that order …
    expect(num).toBeGreaterThan(head);
    expect(icon).toBeGreaterThan(head);
    expect(title).toBeGreaterThan(head);
    expect(num).toBeLessThan(headEnd);
    expect(icon).toBeLessThan(headEnd);
    // … and the description comes after the head is closed.
    expect(desc).toBeGreaterThan(headEnd);
  });

  it('keeps the number and the title as one text column beside the icon', () => {
    // The icon is the first thing in the head; the number and the title share
    // a column after it, so the title starts where the number does.
    const icon = position(markup, 'class="lp-step-icon"');
    const column = position(markup, 'class="lp-step-head-text"');
    const num = position(markup, 'class="lp-step-num"');
    const title = position(markup, '<h3 class="lp-step-title"');
    expect(icon).toBeLessThan(column);
    expect(column).toBeLessThan(num);
    expect(num).toBeLessThan(title);
  });

  it('writes the number with its leading zero and the title as the card heading', () => {
    expect(markup).toContain('<span class="lp-step-num">01</span>');
    expect(markup).toContain(`<h3 class="lp-step-title">${first!.title}</h3>`);
    expect(markup).toContain(`<p class="lp-step-desc">${first!.desc}</p>`);
  });

  it('draws the icon as decoration a screen reader skips', () => {
    const iconStart = position(markup, 'class="lp-step-icon"');
    const svg = markup.slice(iconStart).match(/<svg[^>]*>/)?.[0] ?? '';
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('width="20"');
    expect(svg).toContain('height="20"');
  });

  it('keeps the card class the grid lays out', () => {
    expect(classesOf(markup, 'article', 'lp-step-card')).toContain('lp-step-card');
  });
});
