/**
 * REL-002 §18 — round-aware notification dedupe keys.
 *
 * Round 1 keeps every key exactly as it was before rounds existed, so a row
 * written by an older release and the same message owed by this one still
 * collide on `(template, dedupeKey)` and nothing is sent twice. A later round
 * appends `:r<N>`: the same request, provider and template in Round 2 is a new
 * fact and owes a new message, which the Round 1 row must not suppress.
 *
 * Keys whose subject is already round-specific (an offer id, a publication
 * timestamp, a cancellation) need no suffix and do not use this.
 */

/** `''` for Round 1 (the legacy key), `:r<N>` for Round N ≥ 2. */
export function roundDedupeSuffix(roundNumber: number): string {
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new Error(`A match round number is a positive integer (got ${roundNumber})`);
  }
  return roundNumber === 1 ? '' : `:r${roundNumber}`;
}

const ROUND_SEGMENT = /^r([2-9]|[1-9]\d+)$/;

/**
 * The round a key's trailing segment names: `r<N>` with N ≥ 2, or Round 1 when
 * there is no such segment. `null` for a segment that looks like a round
 * marker but is not a valid one (`r0`, `r1`, `r01`) — a key this code would
 * never have written, so a retry must not guess.
 */
export function roundNumberFromDedupeSegment(segment: string | undefined): number | null {
  if (segment === undefined) {
    return 1;
  }
  const match = ROUND_SEGMENT.exec(segment);
  return match ? Number(match[1]) : null;
}
