import { Prisma, type PrismaClient } from '@prisma/client';

import { equivalentPhoneSpellings, normalizePhoneNumber } from '../modules/phone-verification/phone.util';

/**
 * ADMIN-SEARCH-NORMALIZATION-001: the operator's free-text box, read once.
 *
 * Phone columns are stored in more than one spelling of the same number:
 * `User.phone` and `ProviderProfile.phone` are E.164 (`+905551234567`), while
 * `ServiceRequest.customerPhone` is a snapshot and older rows keep the
 * digits-only form they were written with (`05551234567`, `5551234567`). A
 * plain substring match misses the row whenever the operator types a
 * different — equally correct — spelling than the one stored: a grouped
 * `0555 123 45 67` is inside no stored form, and `+90555…` or `90555…` is not
 * inside an older `0555…` request. (The bare `05551234567` only ever worked
 * against E.164 by accident: it happens to sit inside `+905551234567`.)
 *
 * This module does not normalise anything itself. It asks the platform's one
 * canonicaliser (`normalizePhoneNumber`) whether the box holds a whole phone
 * number and, when it does, the one list of stored spellings
 * (`equivalentPhoneSpellings`) every other lookup already uses. Everything
 * else about the search — substring, which columns — stays what each endpoint
 * already did. Turkish case folding of text columns is the database's, through
 * {@link parseAdminTextSearch} (ADMIN-SEARCH-TURKISH-HARDENING-001).
 */
export type AdminSearchTerm = {
  /** The trimmed box, searched as a substring exactly as before. */
  text: string;
  /**
   * Every stored spelling of the number the box names, when it names one;
   * `null` for anything that is not a whole phone number. At most four values.
   */
  phoneSpellings: string[] | null;
};

/**
 * Only digits, a leading plus and the separators people type between groups.
 *
 * The canonicaliser strips every non-digit before it decides, so without this
 * gate "Usta 5551234567" or an id with ten digits in it would be read as a
 * phone number. The box must *look* like a number before it is asked to be one.
 */
const PHONE_SHAPED = /^\+?[\d\s().-]+$/;

/** The box's phone reading, or `null`: never throws, whatever was typed. */
function phoneSpellingsFor(text: string): string[] | null {
  if (!PHONE_SHAPED.test(text)) return null;

  try {
    return equivalentPhoneSpellings(normalizePhoneNumber(text));
  } catch {
    // A partial number ("5551234"), too many digits, a lone "+": not a whole
    // number, so the substring match below is the whole search.
    return null;
  }
}

/** `null` for an absent or blank box: no search, not a search for nothing. */
export function parseAdminSearch(raw: string | null | undefined): AdminSearchTerm | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  return { text, phoneSpellings: phoneSpellingsFor(text) };
}

/**
 * ADMIN-SEARCH-TURKISH-HARDENING-001: the box as the database search reads it.
 *
 * `folded` is the box passed through `taktic_search_fold` — the same SQL
 * function PostgreSQL stores in every `*Search` generated column — so the
 * operator's text and the stored names are folded by one implementation:
 * NFC, whitespace collapsed, Turkish lower-case (`I`→`ı`, `İ`→`i`). It is
 * matched with a plain, case-sensitive `contains` against those columns.
 *
 * The column's own `contains … mode: 'insensitive'` stays beside it, untouched.
 * That is the locale-free arm: "ivan" still finds "Ivan Petrov" and an
 * all-caps ASCII "ISIK" still finds "isik", which the Turkish fold alone would
 * not (`I`→`ı`). Either arm matching is a match — the rule
 * `matchesAdminSearch` applies in memory, and a strict superset of what the
 * database search did before.
 */
export type AdminTextSearch = AdminSearchTerm & { folded: string };

/** {@link parseAdminSearch}, plus the database's fold of the box. One round trip. */
export async function parseAdminTextSearch(
  db: Pick<PrismaClient, '$queryRaw'>,
  raw: string | null | undefined,
): Promise<AdminTextSearch | null> {
  const term = parseAdminSearch(raw);
  if (!term) return null;
  // A SELECT without FROM always yields exactly one row; the fold of a
  // non-blank string is never NULL (the function is STRICT, the box is not).
  const [{ folded }] = (await db.$queryRaw<Array<{ folded: string }>>(
    Prisma.sql`SELECT taktic_search_fold(${term.text}) AS "folded"`,
  )) as [{ folded: string }];
  return { ...term, folded };
}

export type PhoneColumnMatcher ={ contains: string; mode: 'insensitive' } | { in: string[] };

/**
 * The conditions a phone column joins the search's `OR` with: the substring
 * match it always had, plus — only when the box is a whole number — an exact
 * match on that number's stored spellings.
 *
 * Callers wrap each one in their own column, so the Prisma types stay the
 * endpoint's: `...phoneColumnMatchers(term).map((phone) => ({ phone }))`.
 * The `in` list is bounded (four values at most) and exact, so it adds one
 * index-friendly condition rather than a wildcard per variant.
 */
export function phoneColumnMatchers(term: AdminSearchTerm): PhoneColumnMatcher[] {
  return [
    { contains: term.text, mode: 'insensitive' },
    ...(term.phoneSpellings ? [{ in: term.phoneSpellings }] : []),
  ];
}

/**
 * In-memory twin of the database search, for the two operator lists that are
 * read whole and filtered in the process (providers, requests).
 *
 * `text` columns are matched as a substring of one joined haystack, folded two
 * ways: Turkish (`I` → `ı`, `İ` → `i`), which is what these lists have always
 * done and what makes "ışık" find "Işık", and locale-free, so an address typed
 * with a capital `I` ("Ivan@…") still finds the lower-cased one stored. Either
 * fold matching is a match — a strict superset of the old behaviour.
 *
 * `phone` columns are also matched exactly against the box's spellings, the
 * same rule `phoneColumnMatchers` gives the database.
 */
export function matchesAdminSearch(
  term: AdminSearchTerm,
  columns: { text: ReadonlyArray<string | null | undefined>; phone: ReadonlyArray<string | null | undefined> },
): boolean {
  const haystack = [...columns.text, ...columns.phone].map((value) => value ?? '').join(' ');

  if (haystack.toLocaleLowerCase('tr-TR').includes(term.text.toLocaleLowerCase('tr-TR'))) return true;
  if (haystack.toLowerCase().includes(term.text.toLowerCase())) return true;

  const spellings = term.phoneSpellings;
  return spellings !== null && columns.phone.some((value) => typeof value === 'string' && spellings.includes(value));
}
