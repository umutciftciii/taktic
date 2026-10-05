'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, apiFetch, ProviderCreditTransaction } from '../../../../lib/api';
import { CREDIT_AMOUNT_MAX, creditAmountProblemMessage, parseCreditAmount } from '../../../../lib/credit-amount';
import { formatCount } from '../../../../lib/pagination';
import { rethrowNextControlFlow } from '../../../../lib/next-control-flow';
import type { CreditOperationState, CreditOperationType } from './credit-operation-state';
import { hasConfirmationProof } from '../../../../lib/confirmation-proof-server';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../../../lib/confirmation-proof-keys';

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
  const providerId = readFormString(formData, 'providerId').trim();
  const operation: CreditOperationType =
    readFormString(formData, 'operationType') === 'DEDUCT' ? 'DEDUCT' : 'GRANT';
  // The same reading the form's preview and confirmation used, done again
  // here because an action can be called without the form: "1e2" or "2.5"
  // is refused before anything reaches the API, so nothing is recorded.
  const amount = parseCreditAmount(formData.get('amount'));
  if (!amount.ok) {
    return { kind: 'error', message: `İşlem yapılmadı: ${creditAmountProblemMessage(amount.problem)}`, at: Date.now() };
  }
  if (!providerId) {
    return { kind: 'error', message: 'Hizmet veren bulunamadı; işlem yapılmadı.', at: Date.now() };
  }
  // Both directions are confirmed in a dialog. Without its proof — a click
  // that beat hydration, a post with JavaScript off, a replayed submission —
  // nothing reaches the ledger (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  if (!(await hasConfirmationProof(formData, operation === 'DEDUCT' ? 'credits.deduct' : 'credits.grant'))) {
    return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, at: Date.now() };
  }
  // CAMPAIGN-CREDIT-POLICY-001: the operation's idempotency key, drawn by the
  // form once per operation and repeated on its retries. The confirmation
  // proof above is spent by this submission; the key is what lets the API
  // recognise a retry of an operation it already committed.
  const idempotencyKey = readFormString(formData, 'idempotencyKey').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    return { kind: 'error', message: 'Form henüz hazır değil; sayfayı yenileyip tekrar deneyin. İşlem yapılmadı.', at: Date.now() };
  }
  const payload = { amount: amount.value, reason: readFormString(formData, 'reason').trim(), idempotencyKey };

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
    // What the ledger recorded, which is the validated amount that was sent.
    amount: Math.abs(transaction.amount),
    balanceAfter: transaction.balanceAfter,
    at: Date.now(),
  };
}

/** The API's refusal, in the operator's words. Its raw body never reaches the screen. */
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = readBody(error.body);
    if (error.status === 400 && body.code === 'CREDIT_BALANCE_LIMIT_EXCEEDED') {
      // Judged by the API against the balance at that moment, which may be
      // newer than the one this page shows.
      const current = typeof body.currentBalance === 'number' ? body.currentBalance : null;
      const max = typeof body.maxBalance === 'number' ? body.maxBalance : CREDIT_AMOUNT_MAX;
      return current === null
        ? `İşlem yapılmadı: ekleme sonrası bakiye ${formatCount(max)} üst sınırını aşardı.`
        : `İşlem yapılmadı: ekleme sonrası bakiye ${formatCount(max)} üst sınırını aşardı. Güncel bakiye ${formatCount(current)}; en fazla ${formatCount(Math.max(0, max - current))} kredi eklenebilir. Sayfa eski bakiyeyi gösteriyor olabilir.`;
    }
    if (error.status === 400 && body.code === 'CREDIT_DEDUCT_EXCEEDS_DEDUCTIBLE') {
      // CAMPAIGN-CREDIT-POLICY-001: the balance covers it, the deductible part does not.
      const deductible = typeof body.deductibleCredits === 'number' ? body.deductibleCredits : null;
      const protectedPromo = typeof body.protectedPromoCredits === 'number' ? body.protectedPromoCredits : null;
      const balance = typeof body.balance === 'number' ? body.balance : null;
      return deductible === null || balance === null
        ? 'İşlem yapılmadı: bu düşüş, kampanya kuralı gereği yönetici kesintisine kapalı krediye dokunurdu.'
        : `İşlem yapılmadı: bakiye ${formatCount(balance)}, ancak${protectedPromo !== null ? ` ${formatCount(protectedPromo)} kredisi` : ' bir kısmı'} kampanya kuralı gereği yönetici kesintisine kapalı; en fazla ${formatCount(deductible)} kredi düşülebilir. Sayfa eski bakiyeyi gösteriyor olabilir.`;
    }
    if (error.status === 409 && body.code === 'IDEMPOTENCY_KEY_REUSED') {
      return 'Bu işlem anahtarıyla farklı bir kredi işlemi zaten kaydedilmiş; önceki deneme gerçekleşmiş olabilir. Sayfayı yenileyip bakiyeyi kontrol edin.';
    }
    if (error.status === 500 && body.code === 'WALLET_INVARIANT_VIOLATION') {
      return 'İşlem yapılmadı: hizmet verenin bakiye kayıtları tutarsız. Durumu teknik ekibe bildirin.';
    }
    if (error.status === 400 && error.body.includes('below zero')) {
      return 'Bu düşüş bakiyeyi eksiye düşürürdü; işlem yapılmadı. Bakiye bu arada değişmiş olabilir.';
    }
    if (error.status === 400) {
      return `İşlem yapılmadı: tutar 1 ile ${formatCount(CREDIT_AMOUNT_MAX)} arasında bir tam sayı, sebep en az 3 karakter olmalı.`;
    }
    if (error.status === 409) {
      return 'Bakiye aynı anda başka bir işlemle değişti; işlem yapılmadı. Sayfayı yenileyip tekrar deneyin.';
    }
    if (error.status === 404) {
      return 'Hizmet veren bulunamadı; işlem yapılmadı.';
    }
  }
  // Ambiguous: the request may have committed before its answer was lost.
  // The form keeps the operation's key, so sending it again is safe.
  return 'İşlemin sonucu doğrulanamadı. Aynı işlemi tekrar gönderebilirsiniz; kredi iki kez hareket etmez. Önce sayfayı yenileyip bakiyeyi kontrol etmeniz önerilir.';
}

function readBody(raw: string): {
  code?: unknown;
  currentBalance?: unknown;
  maxBalance?: unknown;
  deductibleCredits?: unknown;
  protectedPromoCredits?: unknown;
  balance?: unknown;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}
