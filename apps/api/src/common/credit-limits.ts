import limits from '@taktic/shared/limits.json';

/**
 * The largest credit amount and the largest credit balance a ledger row can
 * hold: `ProviderCreditTransaction.amount` and `.balanceAfter` are PostgreSQL
 * `integer` columns (2 147 483 647).
 *
 * Read from `packages/shared/limits.json`, the file the admin's manual credit
 * form reads (`apps/admin/lib/credit-amount.ts`), so the form, the DTO and the
 * service refuse the same numbers. JSON rather than the package entry point
 * for the reason `support-ticket-limits.ts` gives.
 */
export const CREDIT_LEDGER_INTEGER_MAX: number = limits.creditLedgerIntegerMax;
