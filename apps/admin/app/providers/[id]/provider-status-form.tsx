'use client';

import { useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import type { ProviderStatus } from '../../../lib/api';
import {
  PROVIDER_STATUSES,
  PROVIDER_STATUS_LABELS as STATUS_LABELS,
  providerStatusConsequence,
} from './provider-status-consequence';

type ProviderStatusFormProps = {
  providerId: string;
  status: ProviderStatus;
  moderationNote: string | null;
  rejectionReason: string | null;
  action: (formData: FormData) => Promise<void> | void;
};

/**
 * The full status form: any status, the moderation note, and the rejection
 * reason the API requires for REJECTED. The same action and the same fields
 * the old moderation dialog sent; what changed is that a move that stops the
 * business working goes through a confirmation that says so, and a cancelled
 * confirmation sends nothing.
 */
export function ProviderStatusForm({
  providerId,
  status,
  moderationNote,
  rejectionReason,
  action,
}: ProviderStatusFormProps) {
  const [selected, setSelected] = useState<ProviderStatus>(status);
  const consequence = providerStatusConsequence(status, selected);
  const unchanged = selected === status;

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
      <label className="detail-form-field" htmlFor="provider-moderation-note">
        <span>Moderasyon notu</span>
        <textarea
          id="provider-moderation-note"
          name="moderationNote"
          defaultValue={moderationNote ?? ''}
          rows={3}
        />
      </label>
      <label className="detail-form-field" htmlFor="provider-rejection-reason">
        <span>
          Ret gerekçesi{' '}
          {selected === 'REJECTED' ? <span className="badge badge-warn">Zorunlu</span> : null}
        </span>
        <textarea
          id="provider-rejection-reason"
          name="rejectionReason"
          defaultValue={rejectionReason ?? ''}
          placeholder="Reddetme durumunda zorunlu"
          required={selected === 'REJECTED'}
          rows={3}
        />
      </label>
      <div className="detail-form-actions">
        {consequence ? (
          <ConfirmDialog
            triggerLabel="Durumu kaydet"
            triggerClassName="btn btn-destructive btn-sm"
            title={`Durum “${STATUS_LABELS[selected]}” olsun mu?`}
            consequence={consequence}
            confirmLabel={selected === 'REJECTED' ? 'Evet, reddet' : selected === 'SUSPENDED' ? 'Evet, askıya al' : 'Evet, kaydet'}
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
