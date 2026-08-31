import { OfferPackageType, ProviderEntitlementStatus } from '@prisma/client';

/**
 * The period arithmetic, in one place, so nothing in this feature can quietly
 * start counting months.
 *
 * A period is thirty times twenty-four hours from the instant the payment
 * settled. It is not a calendar month and it is not "the same day next month":
 *
 *   - 27 September 12:00 → 27 October 12:00
 *   - 31 January 12:00   → 2 March 12:00 (in a non-leap year)
 *   - 2 August 12:00     → 1 September 12:00
 *
 * Calendar arithmetic would make the second and third rows land on dates that
 * do not exist or on a different number of days than the provider paid for, and
 * every one of those bugs surfaces as a provider losing access a day early.
 */
export const PACKAGE_PERIOD_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The end of a period of `periodDays` whole days starting at `startAt`. */
export function periodEnd(startAt: Date, periodDays: number = PACKAGE_PERIOD_DAYS): Date {
  return new Date(startAt.getTime() + periodDays * MS_PER_DAY);
}

/**
 * Where the next period starts.
 *
 * Two rules, and the second is why this is not simply "now":
 *
 * 1. A renewal that lands while the current period is still running starts at
 *    that period's `endAt`. The provider paid for thirty days and gets thirty
 *    days, with no gap and no overlap.
 * 2. A renewal whose payment actually settled *after* the period had already
 *    ended starts at the settlement instant instead. Back-dating it to the old
 *    `endAt` would silently sell a period that had partly elapsed before the
 *    money arrived.
 *
 * `previousEndAt` is null for a first purchase, which starts at settlement.
 */
export function nextPeriodStart(paidAt: Date, previousEndAt: Date | null): Date {
  if (!previousEndAt) {
    return paidAt;
  }

  return paidAt.getTime() > previousEndAt.getTime() ? paidAt : previousEndAt;
}

/** The two products that are periods rather than a balance. */
export const PERIOD_PACKAGE_TYPES: readonly OfferPackageType[] = [
  OfferPackageType.MONTHLY_QUOTA,
  OfferPackageType.CATEGORY_UNLIMITED,
];

export function isPeriodPackageType(type: OfferPackageType): boolean {
  return PERIOD_PACKAGE_TYPES.includes(type);
}

/**
 * Whether an entitlement may be spent right now.
 *
 * Both halves are load-bearing. The status alone is not enough — the sweeper
 * that writes EXPIRED runs on a schedule, and a stopped scheduler must not hand
 * out an extra day of unlimited offering. The clock alone is not enough either:
 * a PAST_DUE period whose `endAt` has not been reached yet is a period whose
 * renewal failed, and it grants nothing.
 */
export function isEntitlementUsable(
  entitlement: { status: ProviderEntitlementStatus; startAt: Date; endAt: Date },
  now: Date,
): boolean {
  return (
    entitlement.status === ProviderEntitlementStatus.ACTIVE &&
    entitlement.startAt.getTime() <= now.getTime() &&
    entitlement.endAt.getTime() > now.getTime()
  );
}

/**
 * The Europe/Istanbul day an instant falls on, as `YYYY-MM-DD`.
 *
 * The daily offer cap on an unlimited package is a *day*, and a day is the one
 * the provider is living in — this marketplace is Turkish and every other
 * date the provider sees is rendered in Europe/Istanbul. Counting in UTC would
 * roll the cap over at three in the morning local time.
 */
export function istanbulDayKey(instant: Date): string {
  return ISTANBUL_DAY.format(instant);
}

const ISTANBUL_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Europe/Istanbul',
});

/**
 * The start of the Europe/Istanbul day containing `instant`, as a UTC instant.
 *
 * Derived from the formatted local date rather than by subtracting a fixed
 * offset, so it stays correct if Turkey ever changes its offset again.
 */
export function istanbulDayStart(instant: Date): Date {
  const parts = ISTANBUL_DAY_PARTS.formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

  // The offset the zone is actually at for this instant, in minutes.
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  const offsetMs = asUtc - Math.floor(instant.getTime() / 1000) * 1000;

  return new Date(
    Date.UTC(read('year'), read('month') - 1, read('day'), 0, 0, 0, 0) - offsetMs,
  );
}

const ISTANBUL_DAY_PARTS = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Europe/Istanbul',
});
