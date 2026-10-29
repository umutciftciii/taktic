'use client';

import { useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import type { ProviderStatus } from '../../../lib/api';
import {
  PROVIDER_STATUSES,
  PROVIDER_STATUS_LABELS as STATUS_LABELS,
  providerApproveConsequence,
  providerDraftConsequence,
  providerStatusConsequence,
} from './provider-status-consequence';
import { providerStatusProofKey } from './provider-status-proof';

/** Said under both reasons: who reads them, and who does not. */
const REASON_HINT =
  'Yalnız yetkili yönetici ekranlarında ve durum geçmişinde görünür; hizmet verene e-postada veya panelde gösterilmez.';

type ProviderStatusFormProps = {
  providerId: string;
  status: ProviderStatus;
  /** The status chosen when the form opens; the current one by default. */
  initialSelection?: ProviderStatus;
  action: (formData: FormData) => Promise<void> | void;
};

/**
 * The full status form: any status, the moderation note, and the reason the
 * API requires for REJECTED and for SUSPENDED. A move that stops the business
 * working (Faz 1), an approval and a move into DRAFT (Faz 2) go through a
 * confirmation that says what they do, each with its own proof key
 * (`providerStatusProofKey`), and a cancelled confirmation sends nothing.
 *
 * PROVIDER-STATUS-001: every field starts empty. The note and the reasons
 * belong to the move being made now — the last move's are on the detail and in
 * the status history — so nothing is carried into the next one by leaving a
 * prefilled field alone. Only the reason the chosen status needs is drawn,
 * and it is required there and again by the API.
 */
export function ProviderStatusForm({ providerId, status, initialSelection, action }: ProviderStatusFormProps) {
  const [selected, setSelected] = useState<ProviderStatus>(initialSelection ?? status);
  const proofKey = providerStatusProofKey(status, selected);
  const unchanged = selected === status;
  const title = `Durum “${STATUS_LABELS[selected]}” olsun mu?`;

  return (
    <form action={action} className="detail-form" data-testid="provider-status-form">
      <input type="hidden" name="id" value={providerId} />
      <label className="detail-form-field" htmlFor="provider-status-select">
        <span>Yeni durum</span>
        <select
          id="provider-status-select"
          name="status"
          value={selected}
          onChange={(event) => setSelected(event.target.value as ProviderStatus)}
        >
          {PROVIDER_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
              {value === status ? ' (mevcut)' : ''}
            </option>
          ))}
        </select>
      </label>
      {selected === 'REJECTED' ? (
        <label className="detail-form-field" htmlFor="provider-rejection-reason">
          <span>
            Ret gerekçesi <span className="badge badge-warn">Zorunlu</span>
          </span>
          <textarea id="provider-rejection-reason" name="rejectionReason" required rows={3} />
          <small className="muted">{REASON_HINT}</small>
        </label>
      ) : null}
      {selected === 'SUSPENDED' ? (
        <label className="detail-form-field" htmlFor="provider-suspension-reason">
          <span>
            Askı gerekçesi <span className="badge badge-warn">Zorunlu</span>
          </span>
          <textarea id="provider-suspension-reason" name="suspensionReason" required rows={3} />
          <small className="muted">{REASON_HINT}</small>
        </label>
      ) : null}
      <label className="detail-form-field" htmlFor="provider-moderation-note">
        <span>Moderasyon notu (iç not)</span>
        <textarea id="provider-moderation-note" name="moderationNote" rows={3} />
        <small className="muted">Bu işleme ait iç not. Önceki not taşınmaz; geçmiş sekmesinde kalır.</small>
      </label>
      <div className="detail-form-actions">
        {proofKey === 'provider.status' ? (
          <ConfirmDialog
            proof="provider.status"
            triggerLabel="Durumu kaydet"
            triggerClassName="btn btn-destructive btn-sm"
            title={title}
            consequence={providerStatusConsequence(status, selected)}
            confirmLabel={selected === 'REJECTED' ? 'Evet, reddet' : selected === 'SUSPENDED' ? 'Evet, askıya al' : 'Evet, kaydet'}
            testId="provider-status-save"
          />
        ) : proofKey === 'provider.approve' ? (
          <ConfirmDialog
            proof="provider.approve"
            triggerLabel="Durumu kaydet"
            triggerClassName="btn btn-primary btn-sm"
            title={title}
            consequence={providerApproveConsequence(status)}
            confirmLabel={status === 'SUSPENDED' ? 'Evet, tekrar aktif et' : 'Evet, onayla'}
            tone="primary"
            testId="provider-status-save"
          />
        ) : proofKey === 'provider.draft' ? (
          <ConfirmDialog
            proof="provider.draft"
            triggerLabel="Durumu kaydet"
            triggerClassName="btn btn-secondary btn-sm"
            title={title}
            consequence={providerDraftConsequence(status)}
            confirmLabel="Evet, taslağa al"
            tone="primary"
            testId="provider-status-save"
          />
        ) : (
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={unchanged}
            title={unchanged ? 'Mevcut durum seçili' : undefined}
            data-testid="provider-status-save"
          >
            Durumu kaydet
          </button>
        )}
      </div>
    </form>
  );
}
