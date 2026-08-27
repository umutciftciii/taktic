/**
 * The password rules the API enforces, in one place.
 *
 * The invite endpoint accepts a password of at least
 * {@link PASSWORD_MIN_LENGTH} and at most {@link PASSWORD_MAX_LENGTH}
 * characters — `@MinLength(8) @MaxLength(128)` on the DTO — and that is the
 * whole policy.
 *
 * A plain module rather than part of the client component that renders the
 * criteria: a Server Component importing a value out of a `'use client'` module
 * receives a client reference, not the number, and interpolating that into a
 * message prints the reference.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
