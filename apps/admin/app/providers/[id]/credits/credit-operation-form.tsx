'use client';

import { useActionState, useEffect, useState } from 'react';
import { ConfirmDialog } from '../../../../components/confirm-dialog';
import { submitCreditOperationAction } from './actions';
import {
  CREDIT_OPERATION_IDLE,
  type CreditOperationType as OperationType,
} from './credit-operation-state';

type CreditOperationFormProps = {
  providerId: string;
  businessName: string;
  currentBalance: number;
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
 * Adding credit goes straight through. Deducting asks first, and the
 * confirmation says the balance before and after and that the row is
 * permanent; cancelling it sends nothing. The server's answer comes back in
 * the action state: a refusal (say, a balance that moved below the amount in
 * the meantime) is shown above the button with everything typed kept, a
 * success says the new balance and clears the form.
 */
export function CreditOperationForm({
  providerId,
  businessName,
  currentBalance,
  canGrant,
  canDeduct,
}: CreditOperationFormProps) {
  const [state, formAction, pending] = useActionState(submitCreditOperationAction, CREDIT_OPERATION_IDLE);
  const [operationType, setOperationType] = useState<OperationType>(canGrant ? 'GRANT' : 'DEDUCT');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');

  // A success clears the fields; a refusal leaves them as they were typed.
  const doneAt = state.kind === 'done' ? state.at : null;
  useEffect(() => {
    if (doneAt !== null) {
      setAmountInput('');
      setReason('');
    }
  }, [doneAt]);

  const parsedAmount = Number.parseInt(amountInput, 10);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const signedDelta = hasAmount ? (operationType === 'GRANT' ? parsedAmount : -parsedAmount) : 0;
  const previewBalance = currentBalance + signedDelta;
  const overdraft = operationType === 'DEDUCT' && hasAmount && parsedAmount > currentBalance;

  const reasonValid = reason.trim().length >= REASON_MIN_LENGTH;
  const submitDisabled = !hasAmount || !reasonValid || overdraft || pending;

  const isDeduct = operationType === 'DEDUCT';

  return (
    <form action={formAction} className="credit-operation-form" data-testid="credit-operation-form">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="operationType" value={operationType} />

      {canGrant && canDeduct ? (
        <div className="credit-operation-tabs" role="tablist" aria-label="İşlem tipi">
          <button
            type="button"
            role="tab"
            aria-selected={!isDeduct}
            className={`credit-operation-tab${!isDeduct ? ' is-active is-grant' : ''}`}
            onClick={() => setOperationType('GRANT')}
          >
            Kredi ekle
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isDeduct}
            className={`credit-operation-tab${isDeduct ? ' is-active is-deduct' : ''}`}
            onClick={() => setOperationType('DEDUCT')}
          >
            Kredi düş
          </button>
        </div>
      ) : null}

      <label className="form-row">
        <span>Tutar</span>
        <input
          name="amount"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          required
          value={amountInput}
          onChange={(event) => setAmountInput(event.target.value)}
          placeholder="Örn. 50"
          data-testid="credit-operation-amount"
        />
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
        {overdraft ? (
          <p className="balance-preview-warning">
            Bu düşüş mevcut bakiyeyi aşıyor. İşlem sunucu tarafında reddedilir.
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
          triggerLabel="Kredi düş"
          triggerClassName="btn btn-danger btn-block"
          title="Kredi düşülsün mü?"
          consequence={
            <>
              <p>
                {hasAmount ? parsedAmount : 0} kredi {businessName} bakiyesinden düşülür: bakiye{' '}
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
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={submitDisabled}
          data-testid="credit-operation-grant"
        >
          Kredi ekle
        </button>
      )}

      <p className="audit-note">
        Bu işlem kredi hareketlerine kalıcı olarak kaydedilir ve işlemi yapan yönetici tutulur.
      </p>
    </form>
  );
}
