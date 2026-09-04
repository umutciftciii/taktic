import limits from '@taktic/shared/limits.json';

/**
 * The support-ticket limits the DTOs enforce, read from the same file the
 * customer's own screens read — `packages/shared/limits.json`.
 *
 * The JSON is imported rather than the package's TypeScript entry point for the
 * reason `common/service-request-limits.ts` documents at length: this app is
 * compiled to CommonJS and run from `dist`, and `@taktic/shared` ships ESM
 * TypeScript source that Node refuses to load at runtime. A JSON file requires
 * cleanly from CommonJS, so the number lives there and both sides read it from
 * there.
 */
export const SUPPORT_TICKET_SUBJECT_MAX_LENGTH = limits.supportTicketSubjectMaxLength;

export const SUPPORT_TICKET_MESSAGE_MAX_LENGTH = limits.supportTicketMessageMaxLength;
