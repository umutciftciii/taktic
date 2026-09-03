import limits from '@taktic/shared/limits.json';

/**
 * The request-description limit the create DTO enforces, read from the same
 * file the public form's counter reads — `packages/shared/limits.json`.
 *
 * The JSON is imported rather than the package's TypeScript entry point on
 * purpose. This app is compiled to CommonJS and run from `dist`, and
 * `@taktic/shared` is `"type": "module"` shipping `.ts` source: a
 * `require('@taktic/shared')` in the built output type-checks and compiles, then
 * throws `SyntaxError: Unexpected token 'export'` the first time Node loads it —
 * the process would not boot. A JSON file has no such problem, which is why the
 * number lives there and both sides read it from there.
 *
 * The same reasoning is why `common/urgency.ts` exists alongside the package's
 * urgency table instead of importing it.
 */
export const SERVICE_REQUEST_DESCRIPTION_MAX_LENGTH = limits.serviceRequestDescriptionMaxLength;
