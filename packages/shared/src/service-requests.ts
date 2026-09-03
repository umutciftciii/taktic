import limits from '../limits.json';

/**
 * The longest description a service request may carry.
 *
 * Counted the way both sides of the wire count it: JavaScript's `string.length`
 * (UTF-16 code units). That is what `@MaxLength` on the create DTO measures,
 * what the browser applies to a textarea's `maxLength`, and what the counter on
 * the public form reports — so the number on screen and the server's answer can
 * never disagree.
 *
 * The value itself lives in `packages/shared/limits.json` rather than here, and
 * that indirection is load-bearing. The API is compiled to CommonJS and started
 * from its own `dist`, so it cannot `require` this package: `@taktic/shared`
 * is `"type": "module"` and ships TypeScript source, which Node refuses to load
 * at runtime. It reads the JSON directly instead (see
 * `apps/api/src/common/service-request-limits.ts`), which requires cleanly from
 * CommonJS. One literal, two readers, no duplicated number.
 *
 * The column behind it stays `TEXT`; this is a product limit, not a storage one.
 */
export const SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH = limits.serviceRequestDescriptionMaxLength;
