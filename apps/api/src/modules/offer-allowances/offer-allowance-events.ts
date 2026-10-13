import { Logger } from '@nestjs/common';
import { SHOWCASE_FREE_OFFER_QUOTA } from './offer-allowance-ledger';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the allowance's operational events, one greppable
 * line each, in the same shape as `common/rel-002-events.ts`:
 * `offer_allowance_event event=<name> key=value …`.
 *
 * Written only after the transaction that caused them committed, so a
 * serialization replay or a refused offer never counts. Ids, numbers and enum
 * values only — never a name, a phone number, an e-mail address or free text.
 */
export type OfferAllowanceEvent =
  | 'offer_allowance_granted'
  | 'offer_allowance_consumed'
  | 'offer_allowance_exhausted_fallback';

export type OfferAllowanceEventFields = Record<string, string | number | boolean | null>;

export function formatOfferAllowanceEvent(
  event: OfferAllowanceEvent,
  fields: OfferAllowanceEventFields,
): string {
  const pairs = Object.entries(fields).map(
    ([key, value]) => `${key}=${value === null ? '-' : String(value)}`,
  );
  return ['offer_allowance_event', `event=${event}`, ...pairs].join(' ');
}

export function logOfferAllowanceEvent(
  logger: Pick<Logger, 'log'>,
  event: OfferAllowanceEvent,
  fields: OfferAllowanceEventFields,
): void {
  logger.log(formatOfferAllowanceEvent(event, fields));
}

const grantLogger = new Logger('OfferAllowance');

/**
 * `offer_allowance_granted`, for a placement whose birth has committed.
 *
 * Called by the four post-commit sites that already announce a newly born run
 * (webhook settlement, mock settlement, the provider spending a right on an
 * approved card, an operator's first approval) — never from inside the birth
 * transaction, which a serialization replay could roll back. A grant born in
 * the transaction always carries the current {@link SHOWCASE_FREE_OFFER_QUOTA}.
 */
export function logShowcaseAllowanceGranted(placementId: string): void {
  logOfferAllowanceEvent(grantLogger, 'offer_allowance_granted', {
    placementId,
    source: 'SHOWCASE_PLACEMENT',
    quotaTotal: SHOWCASE_FREE_OFFER_QUOTA,
  });
}
