import { ApiError } from '../../../../lib/api';

/**
 * API-HARDENING-001: whether an API refusal is the ledger's balance bound
 * (`CREDIT_BALANCE_LIMIT_EXCEEDED`). The API answers it before a payment page
 * opens and again at the mock settlement; either way nothing was charged or
 * loaded. Kept out of the `'use server'` action files so it is not itself an
 * action.
 */
export function isCreditBalanceLimitRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return false;
  }
  try {
    return (JSON.parse(error.body) as { code?: unknown }).code === 'CREDIT_BALANCE_LIMIT_EXCEEDED';
  } catch {
    return false;
  }
}
