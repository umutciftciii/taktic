import { describe, expect, it } from 'vitest';
import {
  heroDemoDurationMs,
  heroDemoNextIndex,
  heroDemoOffers,
  heroDemoShouldRun,
  heroDemoSnapshot,
  heroDemoStages,
  heroDemoStaticSnapshot,
} from '../lib/hero-demo';
import { statusLabel } from '../lib/request-formatters';

/**
 * The three states the hero card walks through, as data rather than as markup.
 *
 * The card on the home page is the one place a visitor sees the product before
 * signing up, so what it claims has to be the product's own vocabulary and its
 * own order — a request is created, offers arrive, the job is done. Holding
 * that as a list of states lets the order, the wording and the timing be
 * asserted here, and leaves the component with nothing to decide but how to
 * paint whichever state it is handed.
 *
 * The browser claims — that the three states are actually reached on screen,
 * that `prefers-reduced-motion` stops the loop dead, and that none of it makes
 * a 320px page scroll sideways — are in `e2e/tests/landing-hero.spec.ts`.
 */

/** The process, in the order a customer lives it. */
const STEPS = ['Talep oluşturuldu', 'Uygun ustalardan teklifler geldi', 'İş tamamlandı'];

describe('the hero request demo', () => {
  it('is the three steps of the process, in order', () => {
    expect(heroDemoStages.map((stage) => stage.label)).toEqual(STEPS);
    expect(heroDemoStages.map((stage) => stage.id)).toEqual(['created', 'offers', 'completed']);
  });

  it('names each step with the status the product itself shows', () => {
    // Not a parallel vocabulary invented for the landing page: these are the
    // same labels the customer's own request board prints for these states.
    expect(heroDemoStages.map((stage) => statusLabel(stage.statusKey))).toEqual([
      'Gönderildi',
      'Onaylandı',
      'Tamamlandı',
    ]);
    for (const stage of heroDemoStages) {
      expect(stage.status, `${stage.id} carries its own status label`).toBe(
        statusLabel(stage.statusKey),
      );
    }
  });

  it('runs one loop in between eight and ten seconds', () => {
    expect(heroDemoDurationMs).toBeGreaterThanOrEqual(8000);
    expect(heroDemoDurationMs).toBeLessThanOrEqual(10000);
    expect(heroDemoStages.reduce((total, stage) => total + stage.holdMs, 0)).toBe(
      heroDemoDurationMs,
    );
  });

  it('holds every step long enough to be read', () => {
    for (const stage of heroDemoStages) {
      expect(stage.holdMs, `"${stage.label}" is on screen long enough to read`).toBeGreaterThanOrEqual(
        2000,
      );
    }
  });

  it('returns to the first step after the last one', () => {
    expect(heroDemoNextIndex(0)).toBe(1);
    expect(heroDemoNextIndex(1)).toBe(2);
    expect(heroDemoNextIndex(heroDemoStages.length - 1)).toBe(0);
  });

  it('marks every step it has reached done, and the ones after it pending', () => {
    // The captions are things that have happened — "Talep oluşturuldu" — so a
    // step is done from the moment the loop is on it, not a beat later. That is
    // also what puts a completion mark against "İş tamamlandı" while it is the
    // step being held, rather than only after the loop has moved past it.
    expect(heroDemoSnapshot(0).steps.map((step) => step.state)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    expect(heroDemoSnapshot(1).steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'pending',
    ]);
    expect(heroDemoSnapshot(2).steps.map((step) => step.state)).toEqual(['done', 'done', 'done']);
  });

  it('points at exactly one step at a time, the one being held', () => {
    for (let index = 0; index < heroDemoStages.length; index += 1) {
      const current = heroDemoSnapshot(index).steps.filter((step) => step.current);
      expect(current.map((step) => step.id)).toEqual([heroDemoStages[index]!.id]);
    }
  });

  it('keeps the step captions on the snapshot in the order of the process', () => {
    expect(heroDemoSnapshot(0).steps.map((step) => step.label)).toEqual(STEPS);
  });

  it('never takes back what it has already shown', () => {
    // A loop that ran backwards for one frame would read as a glitch: offers
    // un-arriving, the quality bar draining. Both only ever go forwards.
    const snapshots = heroDemoStages.map((_stage, index) => heroDemoSnapshot(index));
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1]!;
      const current = snapshots[index]!;
      expect(current.offersVisible).toBeGreaterThanOrEqual(previous.offersVisible);
      expect(current.progress).toBeGreaterThan(previous.progress);
    }
  });

  it('has no offers before they are said to have arrived', () => {
    expect(heroDemoSnapshot(0).offersVisible).toBe(0);
    expect(heroDemoSnapshot(1).offersVisible).toBe(heroDemoOffers.length);
    expect(heroDemoOffers.length).toBeGreaterThan(1);
  });

  it('finishes complete, at a full bar', () => {
    const last = heroDemoSnapshot(heroDemoStages.length - 1);
    expect(last.isComplete).toBe(true);
    expect(last.progress).toBe(100);
    expect(heroDemoSnapshot(0).isComplete).toBe(false);
    expect(heroDemoSnapshot(1).isComplete).toBe(false);
  });

  it('reads an out-of-range index as somewhere in the loop', () => {
    // The component counts upwards and never resets; the model wraps.
    expect(heroDemoSnapshot(3)).toEqual(heroDemoSnapshot(0));
    expect(heroDemoSnapshot(7)).toEqual(heroDemoSnapshot(1));
  });

  it('is the finished process, whole, when motion is refused', () => {
    // `prefers-reduced-motion: reduce` gets no loop at all, so the one frame it
    // does get has to carry the whole story: every step taken, every offer in,
    // and the job done.
    expect(heroDemoStaticSnapshot.steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
    ]);
    expect(heroDemoStaticSnapshot.steps.map((step) => step.label)).toEqual(STEPS);
    expect(heroDemoStaticSnapshot.isComplete).toBe(true);
    expect(heroDemoStaticSnapshot.progress).toBe(100);
    expect(heroDemoStaticSnapshot.offersVisible).toBe(heroDemoOffers.length);

    // It is not a fourth, hand-written state: it is the last frame of the loop,
    // so the still and the ending of the animation cannot drift apart.
    expect(heroDemoStaticSnapshot).toEqual(heroDemoSnapshot(heroDemoStages.length - 1));
  });

  it('says something about every offer it shows', () => {
    for (const offer of heroDemoOffers) {
      expect(offer.title.trim()).toBe(offer.title);
      expect(offer.title.length).toBeGreaterThan(0);
      expect(offer.detail.length).toBeGreaterThan(0);
    }
    expect(new Set(heroDemoOffers.map((offer) => offer.id)).size).toBe(heroDemoOffers.length);
  });

  it('invents no price, no rating and no business name', () => {
    // The landing page has no request to read from, so anything that looked
    // like a real figure would be a made-up one. The rows describe what an
    // offer carries; the numbers appear once the visitor has a request.
    const text = heroDemoOffers.map((offer) => `${offer.title} ${offer.detail}`).join(' ');
    expect(text).not.toMatch(/\d+\s*(₺|TL)/i);
    expect(text).not.toMatch(/\b\d[\d.,]*\s*(puan|yıldız)/i);
  });
});

/**
 * When the loop is allowed to run at all.
 *
 * Three separate things can each stop it, and the component asks them of the
 * browser at different moments — a media query, a `visibilitychange` event, an
 * intersection observer — so the decision itself is pulled out here where it
 * can be stated once and checked in every combination. The component's job is
 * reduced to reporting what it sees.
 */
describe('whether the hero demo loop runs', () => {
  const running = { reducedMotion: false, pageVisible: true, inViewport: true };

  it('runs when the visitor can see it and has not refused motion', () => {
    expect(heroDemoShouldRun(running)).toBe(true);
  });

  it('stops dead when motion is refused, however visible the card is', () => {
    expect(heroDemoShouldRun({ ...running, reducedMotion: true })).toBe(false);
  });

  it('stops while the tab is in the background', () => {
    expect(heroDemoShouldRun({ ...running, pageVisible: false })).toBe(false);
  });

  it('stops while the hero is scrolled off screen', () => {
    expect(heroDemoShouldRun({ ...running, inViewport: false })).toBe(false);
  });

  it('needs every one of them, not one of them', () => {
    expect(
      heroDemoShouldRun({ reducedMotion: true, pageVisible: false, inViewport: false }),
    ).toBe(false);
    expect(
      heroDemoShouldRun({ reducedMotion: false, pageVisible: true, inViewport: false }),
    ).toBe(false);
  });
});
