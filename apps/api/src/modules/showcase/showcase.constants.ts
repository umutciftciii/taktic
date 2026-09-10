import { showcasePriceTermsUnavailable } from './showcase.errors';

/**
 * The fixed terms and bounds of a vitrin card, in one place.
 *
 * Everything here is a product decision rather than a deployment one, so none of
 * it is read from the environment: a deployment that could set its own SLA
 * ceiling, or its own price-responsibility text, would be a deployment making a
 * promise this repository cannot see.
 */

/**
 * The version of the price-responsibility text a provider accepts when they
 * submit a card for review.
 *
 * Bump it whenever {@link SHOWCASE_PRICE_TERMS_TEXT} changes in a way a provider
 * would need to see again. Every version row records the string that was in
 * force when it was submitted, so a bump does not rewrite what anybody already
 * agreed to — it means the next submission is agreeing to something else, and
 * the two are distinguishable afterwards.
 *
 * Note what a bump does *not* do in this phase: it does not re-open versions
 * that are already approved. Nothing renders a card to a customer yet, so there
 * is no live claim standing on an outdated acceptance; when the customer surface
 * ships, deciding what a bump means for cards already live is a product question
 * that belongs with it.
 */
export const SHOWCASE_PRICE_TERMS_VERSION = 'v1';

/**
 * The text itself — the API's copy of what the provider's screen shows.
 *
 * It lives here as well as in the web application because the acceptance is
 * recorded here: a version string with no text behind it in this repository
 * would name nothing, and an auditor asking "what did they accept" would have to
 * find a Next.js component to answer.
 */
export const SHOWCASE_PRICE_TERMS_TEXT =
  'Kartta belirtilen hizmet bedeli ve kapsam hizmet verenin sorumluluğundadır. ' +
  'TakTick bu hizmet bedelini tahsil etmez ve taraflar arasındaki ödemeye müdahil olmaz.';

/**
 * The terms in force right now, refusing to answer when there are none.
 *
 * Fail-closed, and the reason is specific rather than defensive. The checkout
 * asks "is there an acceptance naming this version"; a blank version turns that
 * into a comparison against nothing. Worse, an equally blank stored version
 * would *match* it — so the one state that must never sell a placement is the
 * one state a naive comparison lets through. Refusing to produce a version at
 * all closes both doors, and closes them at the top of the call rather than
 * deep inside a query.
 *
 * The two parameters default to the constants above and exist so the guard can
 * be exercised for what it refuses. Nothing in the application passes them.
 */
export function resolveShowcasePriceTerms(
  version: string = SHOWCASE_PRICE_TERMS_VERSION,
  text: string = SHOWCASE_PRICE_TERMS_TEXT,
): ShowcasePriceTerms {
  const trimmedVersion = version.trim();
  const trimmedText = text.trim();

  if (trimmedVersion === '' || trimmedText === '') {
    throw showcasePriceTermsUnavailable();
  }

  return { version: trimmedVersion, text: trimmedText };
}

export type ShowcasePriceTerms = { version: string; text: string };

/**
 * The response promises, and their bounds.
 *
 * The defaults are the product's own commitment table — three hours for an
 * urgent request, twenty-four for an ordinary one. The bounds are what an
 * operator would refuse anyway; having them in the DTO *and* in a database CHECK
 * means a card promising to answer an urgent request in three weeks cannot be
 * stored at all.
 *
 * Nothing in this phase measures a response against these. The lead flow is a
 * later phase; what ships here is the promise being made, reviewed and frozen
 * onto a version.
 */
export const SHOWCASE_SLA_URGENT_DEFAULT_HOURS = 3;
export const SHOWCASE_SLA_NORMAL_DEFAULT_HOURS = 24;
export const SHOWCASE_SLA_URGENT_MIN_HOURS = 1;
export const SHOWCASE_SLA_URGENT_MAX_HOURS = 24;
export const SHOWCASE_SLA_NORMAL_MIN_HOURS = 1;
export const SHOWCASE_SLA_NORMAL_MAX_HOURS = 72;

/** Text bounds. Generous, and there so a body cannot carry a novel. */
export const SHOWCASE_TITLE_MAX_LENGTH = 120;
export const SHOWCASE_SUMMARY_MAX_LENGTH = 600;
export const SHOWCASE_SCOPE_ITEM_MAX_LENGTH = 160;
export const SHOWCASE_SCOPE_MAX_ITEMS = 12;
export const SHOWCASE_REVIEW_NOTE_MAX_LENGTH = 1000;
export const SHOWCASE_IMAGE_URL_MAX_LENGTH = 500;

/**
 * How many areas one version may claim.
 *
 * A ceiling rather than a product rule: a provider covering forty districts
 * expresses that as the province, and a list that long is far likelier to be a
 * script than a business. It bounds the subset comparison the narrowing rule
 * performs on every edit.
 */
export const SHOWCASE_AREA_MAX_COUNT = 25;

/**
 * The largest price a card may advertise, in minor units — ten million lira.
 *
 * A bound, not a judgement about what work is worth. Without one, a typo of six
 * extra zeroes is a number the database accepts and a customer reads.
 */
export const SHOWCASE_MAX_LISTED_PRICE_MINOR = 1_000_000_000;

// ────────────────────────────────────────────────────────────────────────────
// Phase two: the placement, the feed and the direct lead
// ────────────────────────────────────────────────────────────────────────────

/**
 * The prefix every vitrin package slug must carry, and no offer package may.
 *
 * A configuration guard rather than a naming convention.
 * `LEMON_SQUEEZY_VARIANT_MAP` is keyed by package slug and serves both
 * catalogues from one map, so without a reserved namespace one entry could
 * stand for a credit package and a vitrin package at the same time — and no
 * database constraint could see it, because the two slugs live in two tables.
 *
 * Enforced three times on purpose: here for the DTO, and by a CHECK on each of
 * the two tables. The alternative considered was keying the map by
 * `kind:slug`, which is a breaking change to a `.env` file this work does not
 * touch.
 */
export const SHOWCASE_PACKAGE_SLUG_PREFIX = 'vitrin-';

/** Catalogue bounds, matching the CHECK constraints on ShowcasePackage. */
export const SHOWCASE_PACKAGE_MIN_DURATION_DAYS = 1;
export const SHOWCASE_PACKAGE_MAX_DURATION_DAYS = 365;
export const SHOWCASE_PACKAGE_MAX_PRICE_MINOR = 1_000_000_00;
export const SHOWCASE_PACKAGE_NAME_MAX_LENGTH = 120;
export const SHOWCASE_PACKAGE_SLUG_MAX_LENGTH = 80;
export const SHOWCASE_PACKAGE_DESCRIPTION_MAX_LENGTH = 600;

/** How many cards one feed page returns, and the ceiling a client may ask for. */
export const SHOWCASE_FEED_DEFAULT_LIMIT = 12;
export const SHOWCASE_FEED_MAX_LIMIT = 48;

/**
 * How long the customer has to answer the fallback question before the lead
 * closes itself.
 *
 * The same fourteen days an approved request stays open, and for the same
 * reason: it is the window this product already asks people to act inside, and
 * a second, different one would be a second thing to explain.
 *
 * The timeout produces `CLOSED_UNANSWERED`, never a release. Silence is not
 * consent to hand somebody's request to the whole market.
 */
export const SHOWCASE_LEAD_FALLBACK_TIMEOUT_DAYS = 14;

/** Leads one sweeper pass may touch, and the ceiling on the env override. */
export const DEFAULT_SHOWCASE_SCAN_LIMIT = 200;
export const MAX_SHOWCASE_SCAN_LIMIT = 1000;

/**
 * The direct-lead rate limits: per telephone number, and per address.
 *
 * Two counters rather than one, because they answer different abuses. The
 * telephone limit stops one verified person opening twenty leads on twenty
 * cards in a minute; the address limit stops one script cycling through
 * telephone numbers. Neither is generous, because a genuine customer writing to
 * three businesses in an hour is already well inside both.
 */
export const SHOWCASE_LEAD_RATE_LIMIT_WINDOW_MINUTES = 60;
export const SHOWCASE_LEAD_RATE_LIMIT_PER_PHONE = 5;
export const SHOWCASE_LEAD_RATE_LIMIT_PER_IP = 15;

/**
 * The window inside which a repeated submission is treated as the same lead
 * rather than a second one.
 *
 * Deliberately an application rule with no database constraint behind it — the
 * one place in this feature where that is the right answer. A second, genuine
 * request from the same person to the same business is perfectly possible, so a
 * unique index would refuse something legitimate. Ten minutes is short enough
 * that only a double-submitted form falls inside it.
 */
export const SHOWCASE_LEAD_DEDUPE_WINDOW_MINUTES = 10;

export function readShowcaseScanLimit(): number {
  const raw = process.env.SHOWCASE_SCAN_LIMIT?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_SHOWCASE_SCAN_LIMIT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SHOWCASE_SCAN_LIMIT) {
    throw new Error(
      `SHOWCASE_SCAN_LIMIT must be an integer between 1 and ${MAX_SHOWCASE_SCAN_LIMIT} (received "${raw}")`,
    );
  }

  return parsed;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** When a breached lead with no answer from the customer closes itself. */
export function showcaseFallbackTimeoutCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SHOWCASE_LEAD_FALLBACK_TIMEOUT_DAYS * DAY_IN_MS);
}

/** A placement's end, from the moment it was paid for. */
export function showcasePlacementEndAt(startAt: Date, durationDays: number): Date {
  return new Date(startAt.getTime() + durationDays * DAY_IN_MS);
}
