/**
 * Submission carries no acceptance any more: the provider agreed to the
 * price-responsibility text when they bought the package, and the version's
 * terms columns are written from the reserved right's snapshot.
 *
 * The class is kept — empty — so the route still declares a body type and the
 * global ValidationPipe's `forbidNonWhitelisted` refuses the old
 * `priceTermsAccepted` / `priceTermsVersion` fields with a 400 rather than
 * silently dropping them: a client still sending them is a client built for a
 * flow that no longer exists.
 */
export class SubmitShowcaseCardDto {}
