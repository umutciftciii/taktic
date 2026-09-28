'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch, ProviderCreditTransaction } from '../../../../lib/api';
import { rethrowNextControlFlow } from '../../../../lib/next-control-flow';
import type { CreditOperationState, CreditOperationType } from './credit-operation-state';

/**
 * One manual credit movement, granted or deducted, and what the operator is
 * told about it.
 *
 * Each direction is its own route and its own permission — CREDITS_GRANT for
 * `…/grant`, CREDITS_DEDUCT for `…/deduct` — and the API judges the session on
 * the route it is sent to; the form only decides which route that is. The API
 * records the actor from the session and the reason from the body, in the
 * same row as the movement, and refuses a deduction that would take the
 * balance below zero.
 *
 * A refusal comes back as a message in the action state and the form keeps
 * what was typed. A 401/403 is a navigation (to /login or /yetkisiz) and is
 * re-thrown rather than shown as "could not save" (F14).
 */
export async function submitCreditOperationAction(
  _previous: CreditOperationState,
  formData: FormData,
): Promise<CreditOperationState> {
  const providerId = readFormString(formData, 'providerId');
  const operation: CreditOperationType =
    readFormString(formData, 'operationType') === 'DEDUCT' ? 'DEDUCT' : 'GRANT';
  const payload = creditPayload(formData);

  let transaction: ProviderCreditTransaction;
  try {
    transaction = await apiFetch<ProviderCreditTransaction>(
      `/providers/${providerId}/credits/${operation === 'DEDUCT' ? 'deduct' : 'grant'}`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
  } catch (error) {
    rethrowNextControlFlow(error);
    return { kind: 'error', message: refusalMessage(error), at: Date.now() };
  }

  revalidatePath(`/providers/${providerId}`);
  revalidatePath(`/providers/${providerId}/credits`);
  return {
    kind: 'done',
    operation,
    amount: payload.amount,
    balanceAfter: transaction.balanceAfter,
    at: Date.now(),
  };
}

/** The API's refusal, in the operator's words. Its raw body never reaches the screen. */
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && error.body.includes('below zero')) {
      return 'Bu düşüş bakiyeyi eksiye düşürürdü; işlem yapılmadı. Bakiye bu arada değişmiş olabilir.';
    }
    if (error.status === 400) {
      return 'İşlem yapılmadı: tutar en az 1 olmalı, sebep en az 3 karakter olmalı.';
    }
    if (error.status === 404) {
      return 'Hizmet veren bulunamadı; işlem yapılmadı.';
    }
  }
  return 'İşlem yapılamadı. Lütfen tekrar deneyin; kredi hareketi oluşmadı.';
}

function creditPayload(formData: FormData) {
  return {
    amount: readFormNumber(formData, 'amount'),
    reason: readFormString(formData, 'reason').trim(),
  };
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readFormNumber(formData: FormData, key: string) {
  const value = Number(readFormString(formData, key));
  return Number.isFinite(value) ? value : 0;
}
