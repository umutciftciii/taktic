'use client';

import { useRef, useState } from 'react';

type ProviderStatus = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

const statuses: ProviderStatus[] = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];

const STATUS_LABELS: Record<ProviderStatus, string> = {
  DRAFT: 'Taslak',
  PENDING_REVIEW: 'İnceleme bekliyor',
  APPROVED: 'Onaylandı',
  REJECTED: 'Reddedildi',
  SUSPENDED: 'Askıya alındı',
};

function statusLabel(status: ProviderStatus) {
  return STATUS_LABELS[status] ?? status;
}

function statusBadgeClass(status: ProviderStatus) {
  switch (status) {
    case 'APPROVED':
      return 'badge badge-good';
    case 'PENDING_REVIEW':
    case 'DRAFT':
      return 'badge badge-warn';
    case 'REJECTED':
    case 'SUSPENDED':
      return 'badge badge-bad';
    default:
      return 'badge';
  }
}

type ModerationDialogProps = {
  providerId: string;
  status: ProviderStatus;
  moderationNote: string | null;
  rejectionReason: string | null;
  action: (formData: FormData) => Promise<void> | void;
};

export function ModerationDialog({
  providerId,
  status,
  moderationNote,
  rejectionReason,
  action,
}: ModerationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedStatus, setSelectedStatus] = useState<ProviderStatus>(status);

  const moderationNoteValue = moderationNote ?? '';
  const rejectionReasonValue = rejectionReason ?? '';

  const isApproved = status === 'APPROVED';
  const isSuspended = status === 'SUSPENDED';

  function openDialog() {
    setSelectedStatus(status);
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  async function handleAction(formData: FormData) {
    await action(formData);
    dialogRef.current?.close();
  }

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm" onClick={openDialog}>
        Durum Yönet
      </button>
      <dialog ref={dialogRef} className="moderation-dialog">
        <div className="moderation-dialog-header">
          <div>
            <h3>Moderasyon</h3>
            <p className="muted moderation-dialog-subtitle">
              Mevcut durum:{' '}
              <span className={statusBadgeClass(status)}>{statusLabel(status)}</span>
            </p>
          </div>
          <button
            type="button"
            className="moderation-dialog-close"
            aria-label="Kapat"
            onClick={closeDialog}
          >
            ×
          </button>
        </div>

        <div className="moderation-dialog-body">
          <div className="moderation-dialog-section">
            <h4 className="moderation-dialog-section-title">Hızlı aksiyon</h4>
            <div className="inline-actions moderation-dialog-quick">
              <form action={handleAction}>
                <input type="hidden" name="id" value={providerId} />
                <input type="hidden" name="status" value="APPROVED" />
                <input type="hidden" name="moderationNote" value={moderationNoteValue} />
                <input type="hidden" name="rejectionReason" value={rejectionReasonValue} />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={isApproved}
                  title={isApproved ? 'Mevcut durum' : undefined}
                >
                  Onayla
                </button>
              </form>
              <form action={handleAction}>
                <input type="hidden" name="id" value={providerId} />
                <input type="hidden" name="status" value="SUSPENDED" />
                <input type="hidden" name="moderationNote" value={moderationNoteValue} />
                <input type="hidden" name="rejectionReason" value={rejectionReasonValue} />
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={!isApproved}
                  title={!isApproved ? 'Sadece onaylı sağlayıcılar askıya alınır' : undefined}
                >
                  Askıya al
                </button>
              </form>
              <form action={handleAction}>
                <input type="hidden" name="id" value={providerId} />
                <input type="hidden" name="status" value="APPROVED" />
                <input type="hidden" name="moderationNote" value={moderationNoteValue} />
                <input type="hidden" name="rejectionReason" value={rejectionReasonValue} />
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={!isSuspended}
                  title={!isSuspended ? 'Sadece askıdaki sağlayıcılar tekrar aktifleştirilir' : undefined}
                >
                  Tekrar aktif et
                </button>
              </form>
            </div>
            <p className="muted moderation-dialog-hint">
              Reddetme için tam form kullanılır; ret gerekçesi zorunludur.
            </p>
          </div>

          <hr className="moderation-dialog-divider" />

          <div className="moderation-dialog-section">
            <h4 className="moderation-dialog-section-title">Tam form</h4>
            <form action={handleAction} className="moderation-dialog-form">
              <input type="hidden" name="id" value={providerId} />
              <label className="form-row">
                <span>Durum</span>
                <select
                  name="status"
                  value={selectedStatus}
                  onChange={(event) => setSelectedStatus(event.target.value as ProviderStatus)}
                >
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {statusLabel(value)}
                      {value === status ? ' (mevcut)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row">
                <span>Moderasyon notu</span>
                <textarea name="moderationNote" defaultValue={moderationNoteValue} rows={3} />
              </label>
              <label className="form-row">
                <span>
                  Ret gerekçesi
                  {selectedStatus === 'REJECTED' ? (
                    <span className="badge badge-warn moderation-dialog-required">Zorunlu</span>
                  ) : null}
                </span>
                <textarea
                  name="rejectionReason"
                  defaultValue={rejectionReasonValue}
                  placeholder="Reddetme durumunda zorunlu"
                  required={selectedStatus === 'REJECTED'}
                  rows={3}
                />
              </label>
              <div className="inline-actions moderation-dialog-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeDialog}>
                  Vazgeç
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={selectedStatus === status}
                >
                  Durumu kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
