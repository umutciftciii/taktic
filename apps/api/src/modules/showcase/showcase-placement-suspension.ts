import { ShowcasePlacementSuspendReason } from '@prisma/client';

/**
 * Whether a placement's paid time keeps running while it is off the air.
 *
 * The whole policy is one sentence: **the platform's own obstacles stop the
 * clock; the provider's own actions do not.**
 *
 * Both halves are decisions rather than conveniences.
 *
 * Stopping the clock for our own obstacles is the only honest answer to a
 * provider who paid for thirty days of visibility and got twenty-seven because
 * an operator pulled the shelf or a publishing bug held their card back. They
 * could not use the days, and billing them for it would be charging for
 * something not delivered.
 *
 * Letting it run for the provider's own actions is the answer to a different
 * question. If archiving a card froze the clock, a run could be parked in
 * February and spent in June — turning a dated placement into an undated
 * voucher, which is not what was sold. The same applies to narrowing a service
 * area and to a suspended account: a sanction that banked the remaining days
 * would reward being sanctioned.
 *
 * The cost of the second half is real and is accepted: a provider who archives
 * a card for two weeks and brings it back loses two weeks. That is the price of
 * a run being a run.
 *
 * ## Why the verdict is copied onto every suspension row
 *
 * `ShowcasePlacementSuspension.extendsClock` is written from this function when
 * a suspension **opens**, and `resume()` reads the stored column rather than
 * calling this again. If the policy above ever changes, what happened to a
 * placement last March must not change with it — the same snapshot discipline
 * the refund window, the entitlement period and the card's price terms all use.
 *
 * A database CHECK enforces the consequence independently: a row whose
 * `extendsClock` is false may never record an `endAtAfter` different from its
 * `endAtBefore`.
 */
const CLOCK_STOPPING_REASONS: ReadonlySet<ShowcasePlacementSuspendReason> = new Set([
  ShowcasePlacementSuspendReason.ADMIN_ACTION,
  ShowcasePlacementSuspendReason.CATEGORY_CLOSED,
  ShowcasePlacementSuspendReason.SYSTEM_PUBLISH_BLOCK,
]);

export function suspensionExtendsClock(reason: ShowcasePlacementSuspendReason): boolean {
  return CLOCK_STOPPING_REASONS.has(reason);
}

/**
 * Whether a suspension for this reason lifts on its own when the reason goes
 * away.
 *
 * Every reason but one does. A closed category reopening, a card coming back
 * out of the archive, an area being covered again and a provider being
 * re-approved are all *observable* conditions: the code that changes them
 * resumes the placement in the same transaction.
 *
 * `ADMIN_ACTION` is not an observable condition — it is a person's judgement,
 * and nothing but that person reversing it should put the card back on the air.
 */
export function suspensionLiftsAutomatically(
  reason: ShowcasePlacementSuspendReason,
): boolean {
  return reason !== ShowcasePlacementSuspendReason.ADMIN_ACTION;
}
