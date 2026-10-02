'use client';

import { ConfirmGate, type ConfirmGateDecision } from '../../components/confirm-gate';
import { companySettingsChanges, readCompanySettingsForm, type CompanySettingsValues } from './settings-changes';

/**
 * "Değişiklikleri kaydet": asks only when a value really changes
 * (`company-settings.update`, old → new for each line); a save that changes
 * nothing goes straight through. The action judges the same against the
 * stored settings and refuses a change without the proof
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B).
 */
export function CompanySettingsSubmit({ stored }: { stored: CompanySettingsValues }) {
  function evaluate(form: HTMLFormElement): ConfirmGateDecision | null {
    const changes = companySettingsChanges(stored, readCompanySettingsForm(new FormData(form)));
    if (changes.length === 0) return null;
    return {
      proofs: ['company-settings.update'],
      title: 'Şirket ve e-posta bilgileri değişsin mi?',
      tone: 'primary',
      confirmLabel: 'Evet, kaydet',
      consequence: (
        <>
          <dl className="confirm-dialog-facts" data-testid="company-settings-changes">
            {changes.map((change) => (
              <div key={change.key}>
                <dt>{change.label}</dt>
                <dd>
                  {change.from ?? '—'} → <strong>{change.to ?? '— (boş)'}</strong>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Yasal unvan, destek e-postası ve posta adresi <strong>bundan sonra gönderilecek her e-postanın</strong>{' '}
            altbilgisinde ve gönderen kimliğinde kullanılır. Gönderilmiş e-postalar değişmez. Önceki değerler ayrıca
            saklanmaz; geri dönmek için eski değerleri yeniden girmeniz gerekir.
          </p>
        </>
      ),
    };
  }
  return (
    <ConfirmGate
      triggerLabel="Değişiklikleri kaydet"
      triggerClassName="btn btn-primary"
      evaluate={evaluate}
      testId="company-settings-save"
    />
  );
}
