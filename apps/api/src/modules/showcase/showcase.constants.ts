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
