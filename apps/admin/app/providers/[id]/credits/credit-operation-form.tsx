'use client';

import { useMemo, useState } from 'react';

type OperationType = 'GRANT' | 'DEDUCT';

type CreditOperationFormProps = {
  providerId: string;
  currentBalance: number;
  action: (formData: FormData) => Promise<void> | void;
};

const REASON_MIN_LENGTH = 3;

export function CreditOperationForm({
  providerId,
  currentBalance,
  action,
}: CreditOperationFormProps) {
  const [operationType, setOperationType] = useState<OperationType>('GRANT');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');

  const parsedAmount = Number.parseInt(amountInput, 10);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const signedDelta = hasAmount
    ? operationType === 'GRANT'
      ? parsedAmount
      : -parsedAmount
    : 0;
  const previewBalance = currentBalance + signedDelta;
  const overdraft = operationType === 'DEDUCT' && hasAmount && parsedAmount > currentBalance;

  const reasonTrimmed = reason.trim();
  const reasonValid = reasonTrimmed.length >= REASON_MIN_LENGTH;
  const submitDisabled = !hasAmount || !reasonValid || overdraft;

  const isDeduct = operationType === 'DEDUCT';

  const submitLabel = isDeduct ? 'Kredi düş' : 'Kredi ekle';
  const submitClass = useMemo(
    () => `btn ${isDeduct ? 'btn-danger' : 'btn-primary'} btn-block`,
    [isDeduct],
  );

  return (
    <form action={action} className="credit-operation-form">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="operationType" value={operationType} />

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
        />
        <p className="help-text">
          Sebep zorunludur ve kredi hareketlerine kalıcı olarak kaydedilir.
        </p>
      </label>

      <div className="balance-preview" aria-live="polite">
        <div className="balance-preview-row">
          <span className="balance-preview-label">Mevcut bakiye</span>
          <span className="balance-preview-value">{currentBalance}</span>
        </div>
        <div className="balance-preview-row">
          <span className="balance-preview-label">İşlem</span>
          <span
            className={`balance-preview-delta${
              hasAmount ? (isDeduct ? ' is-deduct' : ' is-grant') : ' is-empty'
            }`}
          >
            {hasAmount ? `${signedDelta > 0 ? '+' : ''}${signedDelta}` : '—'}
          </span>
        </div>
        <div className="balance-preview-row is-total">
          <span className="balance-preview-label">Yeni bakiye</span>
          <span
            className={`balance-preview-value${
              overdraft ? ' is-negative' : ''
            }`}
          >
            {hasAmount ? previewBalance : currentBalance}
          </span>
        </div>
        {overdraft ? (
          <p className="balance-preview-warning">
            Bu düşüş mevcut bakiyeyi aşıyor. İşlem sunucu tarafında reddedilir.
          </p>
        ) : null}
      </div>

      <button type="submit" className={submitClass} disabled={submitDisabled}>
        {submitLabel}
      </button>

      <p className="audit-note">
        Bu işlem kredi hareketlerine kalıcı olarak kaydedilir ve işlemi yapan yönetici tutulur.
      </p>
    </form>
  );
}
