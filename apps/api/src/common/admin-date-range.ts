import { BadRequestException } from '@nestjs/common';
import { isIsoDay, isoDayStart, addIsoDays } from './date-only';

/**
 * An admin list's date filter, read as a window of instants (TIMEZONE-001).
 *
 * The admin screens send what an `<input type="date">` holds: `YYYY-MM-DD`, a
 * calendar day in Europe/Istanbul. Such a day is the half-open window
 * [its Istanbul midnight, the next day's Istanbul midnight): `from` becomes
 * `gte`, `to` becomes `lt` of the day after. These used to go through
 * `new Date('2026-10-27')`, which is UTC midnight — 03:00 in Istanbul — so the
 * window was three hours late and a one-day filter (`from = to`) matched a
 * single millisecond.
 *
 * A full timestamp is still an instant, taken as given (`gte` / `lte`): that
 * is the contract the query parameter always had, and API callers rely on it.
 *
 * An end that cannot be read is a 400, as before; so is a `from` after `to`.
 */
export type AdminDateRange = { gte?: Date; lt?: Date; lte?: Date };

export function parseAdminDateRange(
  fromInput: string | null | undefined,
  toInput: string | null | undefined,
  fromKey: string,
  toKey: string,
): AdminDateRange | undefined {
  const from = typeof fromInput === 'string' ? fromInput.trim() : '';
  const to = typeof toInput === 'string' ? toInput.trim() : '';
  const range: AdminDateRange = {};

  if (from) {
    range.gte = isIsoDay(from) ? isoDayStart(from) : readInstant(from, fromKey);
  }
  if (to) {
    if (isIsoDay(to)) {
      range.lt = isoDayStart(addIsoDays(to, 1));
    } else {
      range.lte = readInstant(to, toKey);
    }
  }

  if (range.gte === undefined && range.lt === undefined && range.lte === undefined) return undefined;

  const reversed =
    range.gte !== undefined &&
    ((range.lt !== undefined && range.gte >= range.lt) || (range.lte !== undefined && range.gte > range.lte));
  if (reversed) {
    throw new BadRequestException(`"${fromKey}" must be on or before "${toKey}"`);
  }
  return range;
}

function readInstant(value: string, key: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException(`Invalid "${key}" date`);
  }
  return instant;
}
