'use client';

import { ConfirmGate, type ConfirmGateDecision } from '../../components/confirm-gate';

/**
 * "Kaydet" beside the unviewed-offer refund window: asks only when the number
 * really changes (`operations.refund-window-update`, old → new); saving the
 * same value goes straight through. The action judges the same against the
 * stored setting (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B).
 */
export function RefundWindowSubmit({ storedHours }: { storedHours: number }) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const raw = new FormData(form).get('unviewedOfferRefundWindowHours');
    const next = Number(typeof raw === 'string' ? raw.trim() : '');
    // A value the action refuses with its own sentence is not worth a
    // question first; nothing is written either way.
    if (!Number.isInteger(next) || next === storedHours) return null;
    return {
      proofs: ['operations.refund-window-update'],
      title: 'Kredi iade süresi değişsin mi?',
      tone: 'primary',
      confirmLabel: 'Evet, kaydet',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="refund-window-change">
            <div>
              <dt>Görüntülenmeyen teklif için iade süresi</dt>
              <dd>
                {storedHours} saat → <strong>{next} saat</strong>
              </dd>
            </div>
          </dl>
          <p>
            Yeni süre <strong>yalnız bundan sonra verilecek tekliflere</strong> uygulanır. Var olan her teklif kendi
            oluşturulduğu andaki iade süresini ve iade zamanını korur.
          </p>
        </>
      ),
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Kaydet"
      triggerClassName="btn btn-primary btn-sm"
      evaluate={evaluate}
      testId="refund-window-save"
    />
  );
}
