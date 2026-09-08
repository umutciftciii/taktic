import { ShowcaseCardKind } from '@prisma/client';

/**
 * What separates a change that needs an operator from one that does not.
 *
 * The product rule is one sentence: **removing areas and changing nothing else
 * publishes itself; everything else waits for review.** This module is that
 * sentence, written so both halves are decided by the same comparison and
 * neither can drift from the other.
 *
 * Why narrowing is exempt at all: a provider who stops serving a district is
 * making a claim strictly smaller than the one already approved. Nothing new is
 * being asserted to a customer, so there is nothing for an operator to check —
 * and making them wait would mean a business had to ask permission before
 * serving fewer people, which is the wrong way round.
 *
 * Why it is still recorded: it changes what is live. A change to live content
 * with nobody's name on it must not be invisible, so the caller writes a
 * `ShowcaseCardAutoPublishAudit` row naming the provider, both versions and the
 * exact keys that went away. It deliberately does not write a
 * `ShowcaseCardReview`: that table is people's decisions, and a system-authored
 * row in it would make "who approved this" unanswerable for every other row.
 */

/** The content of a version, as the comparison sees it. Areas are separate. */
export type ShowcaseVersionContent = {
  kind: ShowcaseCardKind;
  title: string;
  summary: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  listedServicePriceAmount: number | null;
  listedServiceCurrency: string;
  imageUrl: string | null;
  responseSlaUrgentHours: number;
  responseSlaNormalHours: number;
};

export type ShowcaseVersionShape = ShowcaseVersionContent & {
  /** Canonical keys, in no particular order. */
  areaKeys: readonly string[];
};

/**
 * Whether two versions say the same thing.
 *
 * The scope lists compare as sequences, not as sets. Reordering "dahil olanlar"
 * changes what a customer reads first, which is a change to the card — and a
 * comparison that ignored order would publish a reordered scope without anybody
 * looking at it.
 *
 * `imageUrl` is compared because a picture is a claim: swapping the photograph
 * on an approved card is exactly the edit review exists to catch.
 */
export function sameShowcaseContent(
  left: ShowcaseVersionContent,
  right: ShowcaseVersionContent,
): boolean {
  return (
    left.kind === right.kind &&
    left.title === right.title &&
    left.summary === right.summary &&
    sameSequence(left.scopeIncluded, right.scopeIncluded) &&
    sameSequence(left.scopeExcluded, right.scopeExcluded) &&
    left.listedServicePriceAmount === right.listedServicePriceAmount &&
    left.listedServiceCurrency === right.listedServiceCurrency &&
    left.imageUrl === right.imageUrl &&
    left.responseSlaUrgentHours === right.responseSlaUrgentHours &&
    left.responseSlaNormalHours === right.responseSlaNormalHours
  );
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The verdict on one edit against the version currently live.
 *
 * Three outcomes, and the third is not a technicality:
 *
 * - `AUTO_PUBLISH` — the narrowing case, carrying its own evidence: the keys
 *   that were dropped, which is what the audit row stores.
 * - `NO_CHANGE` — the edit says exactly what the live version already says.
 *   A provider who opens the form and saves without changing anything must not
 *   put their own live card into a review queue, and an operator must not be
 *   handed a version to read that is identical to the one they approved last
 *   week. Nothing is written at all.
 * - `REVIEW` — everything else.
 */
export type ShowcaseEditVerdict =
  | { kind: 'AUTO_PUBLISH'; removedAreaKeys: string[] }
  | { kind: 'NO_CHANGE' }
  | { kind: 'REVIEW' };

export function classifyShowcaseEdit(
  live: ShowcaseVersionShape,
  next: ShowcaseVersionShape,
): ShowcaseEditVerdict {
  if (!sameShowcaseContent(live, next)) {
    return { kind: 'REVIEW' };
  }

  const liveKeys = new Set(live.areaKeys);
  const nextKeys = new Set(next.areaKeys);

  // One added area is a wider claim, whatever else the edit did. It goes to an
  // operator even when the same edit also removed three others: the removals do
  // not buy the addition, and netting them off would be a way to widen coverage
  // without review.
  for (const key of nextKeys) {
    if (!liveKeys.has(key)) {
      return { kind: 'REVIEW' };
    }
  }

  const removedAreaKeys = [...liveKeys].filter((key) => !nextKeys.has(key)).sort();

  // Same content, same areas: the edit changed nothing.
  if (removedAreaKeys.length === 0) {
    return { kind: 'NO_CHANGE' };
  }

  return { kind: 'AUTO_PUBLISH', removedAreaKeys };
}
