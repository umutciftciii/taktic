import { statusLabel } from './request-formatters';

/**
 * The three states the hero's request card walks through, and nothing else.
 *
 * The card beside the slogan used to be a still life: it named the parts of a
 * request and stopped there. What it never showed is the part that is hard to
 * put in a sentence — that a request is created once and then keeps moving on
 * its own, collects offers, and ends with the job done. This is that process,
 * held as three states with a hold time each, so the card can be walked through
 * them instead of a video being played at the visitor.
 *
 * Everything about the loop that can be decided without a browser is decided
 * here: what each state says, which product status it corresponds to, how long
 * it is held, how far the quality bar has filled and how many offers have
 * arrived by then. The component owns one number — which state it is on — and
 * asks for a snapshot; `test/hero-demo.spec.ts` asserts the rest.
 *
 * Two rules the tests hold onto. The loop only ever moves forwards, because a
 * bar that drains or an offer that un-arrives reads as a bug rather than as a
 * loop. And nothing here is a figure: no price, no rating, no business name.
 * The landing page has no request to read those from, so the offer rows say
 * what an offer carries and leave the numbers to the panel, where they are real.
 */

/** The states, in the order a customer lives them. */
export type HeroDemoStageId = 'created' | 'offers' | 'completed';

/**
 * The lifecycle statuses these three states stand for. Keeping the key rather
 * than the Turkish means the card cannot drift into a private vocabulary: it
 * prints whatever `statusLabel` prints everywhere else in the product.
 */
export type HeroDemoStatusKey = 'SUBMITTED' | 'APPROVED' | 'COMPLETED';

export type HeroDemoStage = {
  id: HeroDemoStageId;
  /** The lifecycle state this step corresponds to. */
  statusKey: HeroDemoStatusKey;
  /** That state's label, as the rest of the product prints it. */
  status: string;
  /** The step's caption in the card's rail — what has just happened. */
  label: string;
  /** One line under the caption, saying what the platform did. */
  detail: string;
  /** How full the quality bar is once this step is reached, 0–100. */
  progress: number;
  /** How many of the offer rows have arrived by this step. */
  offersVisible: number;
  /** How long this step is held before the next one takes over. */
  holdMs: number;
};

/**
 * A row in the offers list.
 *
 * Deliberately not a business: an offer on the landing page would have to
 * invent a name and a price, and the point of the card is that the visitor's
 * own request is what produces those.
 */
export type HeroDemoOffer = {
  id: string;
  title: string;
  detail: string;
};

/**
 * Where a step stands, seen from whichever step the loop is currently on.
 *
 * There are only two: the captions name things that have happened, so a step is
 * done from the moment the loop reaches it. Which one is being held is a
 * separate question, and `current` answers it — that way the last step carries
 * its completion mark while it is on screen rather than only after it.
 */
export type HeroDemoStepState = 'done' | 'pending';

export type HeroDemoStep = {
  id: HeroDemoStageId;
  label: string;
  state: HeroDemoStepState;
  /** The step the loop is holding, and the only one the card highlights. */
  current: boolean;
};

/** Everything the card needs to paint one frame of the loop. */
export type HeroDemoSnapshot = {
  /** The step being held, normalised into the loop. */
  index: number;
  stage: HeroDemoStage;
  /** All three steps, each knowing where it stands relative to `index`. */
  steps: readonly HeroDemoStep[];
  offersVisible: number;
  progress: number;
  isComplete: boolean;
};

function stage(
  id: HeroDemoStageId,
  statusKey: HeroDemoStatusKey,
  rest: Omit<HeroDemoStage, 'id' | 'statusKey' | 'status'>,
): HeroDemoStage {
  return { id, statusKey, status: statusLabel(statusKey), ...rest };
}

/**
 * The loop: roughly nine seconds, split so the middle step — the one carrying
 * the offers as they land — gets the longest hold, and the finished state is
 * held long enough to be seen as an ending rather than as a flicker.
 */
export const heroDemoStages: readonly HeroDemoStage[] = [
  stage('created', 'SUBMITTED', {
    label: 'Talep oluşturuldu',
    detail: 'Kategoriye özel sorularla netleşti.',
    progress: 34,
    offersVisible: 0,
    holdMs: 2600,
  }),
  stage('offers', 'APPROVED', {
    label: 'Uygun ustalardan teklifler geldi',
    detail: 'Bölgendeki onaylı işletmelere iletildi.',
    progress: 72,
    offersVisible: 3,
    holdMs: 3400,
  }),
  stage('completed', 'COMPLETED', {
    label: 'İş tamamlandı',
    detail: 'Teklif kabul edildi, talep kapandı.',
    progress: 100,
    offersVisible: 3,
    holdMs: 3000,
  }),
];

/** The rows that appear once the request has reached the providers. */
export const heroDemoOffers: readonly HeroDemoOffer[] = [
  { id: 'offer-1', title: 'Onaylı işletme', detail: 'Fiyat ve iş tanımı' },
  { id: 'offer-2', title: 'Onaylı işletme', detail: 'Başlama zamanı' },
  { id: 'offer-3', title: 'Onaylı işletme', detail: 'Profil ve iş geçmişi' },
];

/** One full pass through the three states. */
export const heroDemoDurationMs: number = heroDemoStages.reduce(
  (total, entry) => total + entry.holdMs,
  0,
);

/** The step after this one, wrapping back to the first so the loop closes. */
export function heroDemoNextIndex(index: number): number {
  return (normalise(index) + 1) % heroDemoStages.length;
}

/**
 * The card's whole state for one step of the loop.
 *
 * The index wraps, so the component can keep a counter that only ever goes up
 * and never has to think about where the loop ends.
 */
export function heroDemoSnapshot(index: number): HeroDemoSnapshot {
  const at = normalise(index);
  const current = heroDemoStages[at]!;

  return {
    index: at,
    stage: current,
    steps: heroDemoStages.map((entry, position) => ({
      id: entry.id,
      label: entry.label,
      state: position <= at ? 'done' : 'pending',
      current: position === at,
    })),
    offersVisible: current.offersVisible,
    progress: current.progress,
    isComplete: current.id === 'completed',
  };
}

/**
 * What the card shows when the visitor has asked for no motion.
 *
 * There is no loop to watch in that case, so the single frame has to say the
 * whole thing: all three steps taken, every offer in, the job done. That frame
 * already exists — it is the last one of the loop — so this is that rather than
 * a fourth state written out by hand, and the still cannot drift away from the
 * ending it is standing in for.
 */
export const heroDemoStaticSnapshot: HeroDemoSnapshot = heroDemoSnapshot(
  heroDemoStages.length - 1,
);

/** What the browser has told the card about the visitor's circumstances. */
export type HeroDemoConditions = {
  /** The visitor asked for reduced motion. */
  reducedMotion: boolean;
  /** The tab is the one being looked at. */
  pageVisible: boolean;
  /** The hero is somewhere on screen. */
  inViewport: boolean;
};

/**
 * Whether the loop is allowed to be running right now.
 *
 * All three have to hold. Each is reported by a different browser API and each
 * changes at a different moment, so the rule lives here rather than being
 * spelled out again in every effect that observes one of them — and it can be
 * checked in every combination without a browser.
 */
export function heroDemoShouldRun({
  reducedMotion,
  pageVisible,
  inViewport,
}: HeroDemoConditions): boolean {
  return !reducedMotion && pageVisible && inViewport;
}

function normalise(index: number): number {
  const count = heroDemoStages.length;
  return ((Math.trunc(index) % count) + count) % count;
}
