import { BadRequestException } from '@nestjs/common';
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

export const CREDIT_BALANCE_LIMIT_EXCEEDED = 'CREDIT_BALANCE_LIMIT_EXCEEDED';

/**
 * The one refusal every credit-*raising* path answers with when the balance
 * would pass {@link CREDIT_LEDGER_INTEGER_MAX} (API-HARDENING-001): 400
 * `CREDIT_BALANCE_LIMIT_EXCEEDED`, thrown before the ledger row is written so
 * the caller's transaction rolls back whole — never PostgreSQL's out-of-range
 * error surfacing as a 500.
 */
export function creditBalanceLimitExceeded(currentBalance: number, maxBalance: number = CREDIT_LEDGER_INTEGER_MAX) {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: CREDIT_BALANCE_LIMIT_EXCEEDED,
    message: `Credit balance cannot exceed ${maxBalance}`,
    currentBalance,
    maxBalance,
  });
}

export function isCreditBalanceLimitExceeded(error: unknown): boolean {
  if (!(error instanceof BadRequestException)) {
    return false;
  }
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === CREDIT_BALANCE_LIMIT_EXCEEDED;
}

/** Whether `amount` more credit on top of `currentBalance` stays within the ledger column. */
export function fitsCreditLedger(currentBalance: number, amount: number): boolean {
  return currentBalance + amount <= CREDIT_LEDGER_INTEGER_MAX;
}
