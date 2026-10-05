'use client';

import { useActionState, useEffect, useState } from 'react';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { CREDIT_AMOUNT_MAX, creditAmountProblemMessage, parseCreditAmount } from '../../../../lib/credit-amount';
import { formatCount } from '../../../../lib/pagination';
import { submitCreditOperationAction } from './actions';
import { CreditGrantConsequence } from './credit-grant-consequence';
import { handleTablistKeyDown } from '../../../../lib/tablist-keys';
import {
  CREDIT_OPERATION_IDLE,
  type CreditOperationType as OperationType,
} from './credit-operation-state';

type CreditOperationFormProps = {
  providerId: string;
  businessName: string;
  currentBalance: number;
  /**
   * CAMPAIGN-CREDIT-POLICY-001: paid credit plus the campaign credit whose
   * version allows an admin deduction. A deduction is judged against this,
   * not the balance. Null when the API could not split the wallet — then no
   * deduction is offered.
   */
  deductibleBalance: number | null;
  /**
   * Which operations this session may perform: CREDITS_GRANT and
   * CREDITS_DEDUCT, computed on the server. They are separate permissions, so
   * each tab is offered only when its own permission is held. The caller does
   * not render the form when neither is held.
   */
  canGrant: boolean;
  canDeduct: boolean;
};

const REASON_MIN_LENGTH = 3;

/**
 * The manual credit form (ADMIN-DESIGN-001 Faz 3B).
 *
 * Both directions ask first. Deducting always did; adding does since
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001, because a grant is the more dangerous
 * mistake — an extra zero is spendable at once and can only be taken back by a
 * separate deduction, if it has not been spent. Each confirmation says the
 * business, the amount, the balance before and after and that the row is
 * permanent; cancelling it sends nothing. The server's answer comes back in
 * the action state: a refusal (say, a balance that moved below the amount in
 * the meantime) is shown above the button with everything typed kept, a
 * success says the new balance and clears the form.
 */
export function CreditOperationForm({
  providerId,
  businessName,
  currentBalance,
  deductibleBalance,
  canGrant,
  canDeduct,
}: CreditOperationFormProps) {
  const [state, formAction, pending] = useActionState(submitCreditOperationAction, CREDIT_OPERATION_IDLE);
  const [operationType, setOperationType] = useState<OperationType>(canGrant ? 'GRANT' : 'DEDUCT');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');

  // CAMPAIGN-CREDIT-POLICY-001: one idempotency key per business operation.
  // Drawn after hydration (never during the server render, so the two renders
  // agree), kept across every retry — a refusal, a timeout or a lost answer
  // sends the same key again, so the API moves the credit at most once — and
  // replaced only once an operation has succeeded.
  const [operationKey, setOperationKey] = useState('');
  useEffect(() => {
    setOperationKey(newOperationKey());
  }, []);

  // A success clears the fields; a refusal leaves them as they were typed.
  const doneAt = state.kind === 'done' ? state.at : null;
  useEffect(() => {
    if (doneAt !== null) {
      setAmountInput('');
      setReason('');
      setOperationKey(newOperationKey());
    }
  }, [doneAt]);

  // The one reading of the typed amount (lib/credit-amount.ts). The preview,
  // the confirmation and the server action all use it, so "1e2" cannot be
  // previewed as 1 and sent as 100: it is not an amount anywhere.
  const amount = parseCreditAmount(amountInput);
  const hasAmount = amount.ok;
  const parsedAmount = amount.ok ? amount.value : 0;
  const amountProblem = !amount.ok && amount.problem !== 'empty' ? creditAmountProblemMessage(amount.problem) : null;
  const signedDelta = hasAmount ? (operationType === 'GRANT' ? parsedAmount : -parsedAmount) : 0;
  const previewBalance = currentBalance + signedDelta;
  const overdraft = operationType === 'DEDUCT' && hasAmount && parsedAmount > currentBalance;
  // Within the balance but beyond what a deduction may take: campaign credit
  // whose version is PAID_ONLY stays out of reach (CAMPAIGN-CREDIT-POLICY-001).
  const deductUnavailable = operationType === 'DEDUCT' && deductibleBalance === null;
  const exceedsDeductible =
    operationType === 'DEDUCT' && hasAmount && !overdraft && deductibleBalance !== null && parsedAmount > deductibleBalance;
  // The balance lives in the same integer column as the amount.
  const overflow = operationType === 'GRANT' && hasAmount && previewBalance > CREDIT_AMOUNT_MAX;

  const reasonValid = reason.trim().length >= REASON_MIN_LENGTH;
  const submitDisabled =
    !hasAmount || !reasonValid || overdraft || exceedsDeductible || deductUnavailable || overflow || pending || operationKey === '';

  const isDeduct = operationType === 'DEDUCT';

  return (
    <form action={formAction} className="credit-operation-form" data-testid="credit-operation-form">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="operationType" value={operationType} />
      <input type="hidden" name="idempotencyKey" value={operationKey} data-testid="credit-operation-key" />

      {canGrant && canDeduct ? (
        <div
          className="credit-operation-tabs"
          role="tablist"
          aria-label="İşlem tipi"
          onKeyDown={(event) => handleTablistKeyDown(event, (index) => setOperationType(index === 0 ? 'GRANT' : 'DEDUCT'))}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isDeduct}
            tabIndex={isDeduct ? -1 : 0}
            className={`credit-operation-tab${!isDeduct ? ' is-active is-grant' : ''}`}
            onClick={() => setOperationType('GRANT')}
          >
            Kredi ekle
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isDeduct}
            tabIndex={isDeduct ? 0 : -1}
            className={`credit-operation-tab${isDeduct ? ' is-active is-deduct' : ''}`}
            onClick={() => setOperationType('DEDUCT')}
          >
            Kredi düş
          </button>
        </div>
      ) : null}

      <label className="form-row">
        <span>Tutar</span>
        {/*
          Text, not type="number": a number field accepts "1e2" and "2.5" and
          reports its value differently per browser. The digits rule is the
          form's own and the server's (lib/credit-amount.ts).
        */}
        <input
          name="amount"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          required
          value={amountInput}
          onChange={(event) => setAmountInput(event.target.value)}
          placeholder="Örn. 50"
          aria-invalid={amountProblem ? true : undefined}
          aria-describedby={amountProblem ? 'credit-operation-amount-problem' : undefined}
          data-testid="credit-operation-amount"
        />
        {amountProblem ? (
          <p className="help-text is-error" id="credit-operation-amount-problem" data-testid="credit-operation-amount-invalid">
            {amountProblem}
          </p>
        ) : null}
      </label>

      <label className="form-row">
        <span>Sebep / yönetici notu</span>
        <textarea
          name="reason"
          required
          minLength={REASON_MIN_LENGTH}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Bu işlemin nedeni (zorunlu, en az 3 karakter)"
          data-testid="credit-operation-reason"
        />
        <p className="help-text">Sebep zorunludur ve kredi hareketlerine kalıcı olarak kaydedilir.</p>
      </label>

      <div className="balance-preview" aria-live="polite">
        <div className="balance-preview-row">
          <span className="balance-preview-label">Mevcut bakiye</span>
          <span className="balance-preview-value">{currentBalance}</span>
        </div>
        <div className="balance-preview-row">
          <span className="balance-preview-label">İşlem</span>
          <span
            className={`balance-preview-delta${hasAmount ? (isDeduct ? ' is-deduct' : ' is-grant') : ' is-empty'}`}
          >
            {hasAmount ? `${signedDelta > 0 ? '+' : ''}${signedDelta}` : '—'}
          </span>
        </div>
        <div className="balance-preview-row is-total">
          <span className="balance-preview-label">Yeni bakiye</span>
          <span className={`balance-preview-value${overdraft ? ' is-negative' : ''}`}>
            {hasAmount ? previewBalance : currentBalance}
          </span>
        </div>
        {overflow ? (
          <p className="balance-preview-warning" data-testid="credit-operation-overflow">
            Bakiye en fazla {formatCount(CREDIT_AMOUNT_MAX)} olabilir. Ekranda görünen bakiyeye göre en fazla{' '}
            {formatCount(Math.max(0, CREDIT_AMOUNT_MAX - currentBalance))} kredi eklenebilir; işlem sunucu
            tarafında reddedilir.
          </p>
        ) : null}
        {overdraft ? (
          <p className="balance-preview-warning">
            Bu düşüş mevcut bakiyeyi aşıyor. İşlem sunucu tarafında reddedilir.
          </p>
        ) : null}
        {isDeduct && deductibleBalance !== null ? (
          <div className="balance-preview-row">
            <span className="balance-preview-label">Kesilebilir toplam</span>
            <span className="balance-preview-value" data-testid="credit-operation-deductible">
              {deductibleBalance}
            </span>
          </div>
        ) : null}
        {exceedsDeductible ? (
          <p className="balance-preview-warning" data-testid="credit-operation-exceeds-deductible">
            Bu düşüş kesilebilir toplamı ({deductibleBalance}) aşıyor. Bakiyenin {currentBalance - (deductibleBalance ?? 0)}{' '}
            kredisi, kampanya kuralı gereği yönetici kesintisine kapalı kampanya kredisi (ya da süresi dolmuş kredi). İşlem
            sunucu tarafında reddedilir.
          </p>
        ) : null}
        {deductUnavailable ? (
          <p className="balance-preview-warning" data-testid="credit-operation-deduct-unavailable">
            Bakiye dağılımı okunamadı; kesinti yapılamaz. Durumu teknik ekibe bildirin.
          </p>
        ) : null}
      </div>

      {state.kind === 'error' ? (
        <div className="notice notice-error" role="alert" data-testid="credit-operation-error">
          {state.message}
        </div>
      ) : state.kind === 'done' ? (
        <div className="notice notice-success" role="status" data-testid="credit-operation-done">
          {state.amount} kredi {state.operation === 'DEDUCT' ? 'düşüldü' : 'eklendi'}. Yeni bakiye{' '}
          {state.balanceAfter}.
        </div>
      ) : null}

      {isDeduct ? (
        <ConfirmDialog
          proof="credits.deduct"
          triggerLabel="Kredi düş"
          triggerClassName="btn btn-danger btn-block"
          title="Kredi düşülsün mü?"
          consequence={
            <>
              <p>
                {parsedAmount} kredi {businessName} bakiyesinden düşülür: bakiye{' '}
                {currentBalance} → {previewBalance}.
              </p>
              <p>
                Hareket, yazdığınız sebep ve sizin adınızla kredi hareketlerine kalıcı olarak kaydedilir;
                silinemez. Yanlış bir düşme ancak ayrı bir kredi ekleme işlemiyle dengelenir.
              </p>
            </>
          }
          confirmLabel="Evet, düş"
          disabled={submitDisabled}
          testId="credit-operation-deduct"
        />
      ) : (
        <ConfirmDialog
          proof="credits.grant"
          triggerLabel="Kredi ekle"
          triggerClassName="btn btn-primary btn-block"
          tone="primary"
          title="Kredi eklensin mi?"
          consequence={
            <CreditGrantConsequence
              businessName={businessName}
              amount={parsedAmount}
              balanceBefore={currentBalance}
              balanceAfter={previewBalance}
              reason={reason}
            />
          }
          confirmLabel="Evet, kredi ekle"
          disabled={submitDisabled}
          testId="credit-operation-grant"
        />
      )}

      <p className="audit-note">
        Bu işlem kredi hareketlerine kalıcı olarak kaydedilir ve işlemi yapan yönetici tutulur.
      </p>
    </form>
  );
}

/** A fresh idempotency key: a random UUID, never derived from the operation itself. */
function newOperationKey(): string {
  return globalThis.crypto.randomUUID();
}

