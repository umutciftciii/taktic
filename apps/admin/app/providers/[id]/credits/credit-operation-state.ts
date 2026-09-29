/**
 * What the manual credit form shows after a submission. Its own module because
 * a `'use server'` file may export only async functions.
 *
 * `at` makes every outcome a new value, so the form can tell two refusals of
 * the same kind apart and clear itself after each success.
 */
export type CreditOperationType = 'GRANT' | 'DEDUCT';

export type CreditOperationState =
  | { kind: 'idle' }
  | { kind: 'done'; operation: CreditOperationType; amount: number; balanceAfter: number; at: number }
  | { kind: 'error'; message: string; at: number };

export const CREDIT_OPERATION_IDLE: CreditOperationState = { kind: 'idle' };
