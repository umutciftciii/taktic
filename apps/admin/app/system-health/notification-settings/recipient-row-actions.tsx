'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { RECIPIENT_REASON_MAX_LENGTH, RECIPIENT_REASON_MIN_LENGTH, type RecipientView } from '../../../lib/ops-alert-recipients';
import {
  deleteRecipientAction,
  pauseRecipientAction,
  replaceRecipientAddressAction,
  resumeRecipientAction,
  revealRecipientAction,
  testRecipientAction,
} from './actions';
import { LastCriticalStep } from './last-critical-step';
import { RECIPIENT_ACTION_IDLE, type RecipientActionState } from './recipient-action-state';

/**
 * The actions of one alert recipient (OBS-ALERT-002 PR-B, task B3), and the
 * delete and address-replacement windows they open.
 *
 * Who sees what is the page's decision (the permission set never reaches the
 * client): WRITE edits, pauses and resumes; DELETE deletes; WRITE + DELETE
 * replaces the address; TEST sends a test e-mail; only a SUPER_ADMIN gets
 * "Göster". The API checks each of them again.
 *
 * Pause, delete, replace and reveal sit behind a ConfirmDialog whose proof the
 * server action verifies before it calls the API. A pause or delete of the
 * last critical recipient is then refused once by the API and asks a second,
 * separate confirmation (`last-critical-step.tsx`); on production's last live
 * channel it is a dead end with no confirmation at all.
 *
 * The revealed address lives in `RevealControl`'s own state, only while its
 * window is open: closing the window sets it back to null. It is never put in
 * the URL, a cookie, storage or anything that outlives the window.
 */

const PATH = '/system-health/notification-settings';

export type RecipientRowPermissions = {
  write: boolean;
  remove: boolean;
  replace: boolean;
  test: boolean;
  /** SUPER_ADMIN only (OPS_ALERT_RECIPIENTS_REVEAL is reserved to the root role). */
  reveal: boolean;
};

type RowRecipient = Pick<RecipientView, 'id' | 'version' | 'label' | 'status' | 'maskedAddress' | 'isLastCritical'>;

export function RecipientRowActions({ recipient, can }: { recipient: RowRecipient; can: RecipientRowPermissions }) {
  const live = recipient.status !== 'DELETED';
  return (
    <>
      {can.write ? (
        <Link
          className="btn btn-secondary btn-sm"
          href={`${PATH}?alici=${encodeURIComponent(recipient.id)}`}
          scroll={false}
          data-testid="ops-alert-recipient-edit"
        >
          Düzenle
        </Link>
      ) : null}
      {can.test && live ? <TestSendForm recipient={recipient} /> : null}
      {can.write && recipient.status === 'ACTIVE' ? <PauseForm recipient={recipient} /> : null}
      {can.write && recipient.status === 'PAUSED' ? <ResumeForm recipient={recipient} /> : null}
      {can.replace && live ? (
        <Link
          className="btn btn-secondary btn-sm"
          href={`${PATH}?alici=${encodeURIComponent(recipient.id)}&islem=adres`}
          scroll={false}
          data-testid="ops-alert-recipient-replace-link"
        >
          Adresi değiştir
        </Link>
      ) : null}
      {can.remove && live ? (
        <Link
          className="btn btn-destructive btn-sm"
          href={`${PATH}?alici=${encodeURIComponent(recipient.id)}&islem=sil`}
          scroll={false}
          data-testid="ops-alert-recipient-delete-link"
        >
          Sil
        </Link>
      ) : null}
      {can.reveal && live ? <RevealControl recipient={recipient} /> : null}
    </>
  );
}

function Target({ recipient }: { recipient: Pick<RowRecipient, 'id' | 'version'> }) {
  return (
    <>
      <input type="hidden" name="recipientId" value={recipient.id} />
      <input type="hidden" name="version" value={recipient.version} />
    </>
  );
}

function ActionError({ state, testId }: { state: RecipientActionState; testId: string }) {
  if (state.kind !== 'error') return null;
  return (
    <p className="notice notice-error" role="alert" data-testid={testId} data-code={state.code ?? undefined}>
      {state.message}
    </p>
  );
}

function LastCriticalHint({ recipient }: { recipient: RowRecipient }) {
  return recipient.isLastCritical ? (
    <p>Bu alıcı kritik bildirim alan son e-posta alıcısı; ayrıca ikinci bir onay istenecek.</p>
  ) : null;
}

function PauseForm({ recipient }: { recipient: RowRecipient }) {
  const [state, action] = useActionState(pauseRecipientAction, RECIPIENT_ACTION_IDLE);
  const stepped = state.kind === 'last-critical' || state.kind === 'last-channel';
  return (
    <form action={action} className="inline-form" data-testid="ops-alert-recipient-pause-form">
      <Target recipient={recipient} />
      {stepped ? (
        <LastCriticalStep
          state={state}
          leadProof="ops-alert-recipient.pause"
          confirmLabel="Yine de duraklat"
          testId="ops-alert-recipient-pause-last-critical"
        />
      ) : (
        <ConfirmDialog
          triggerLabel="Duraklat"
          proof="ops-alert-recipient.pause"
          triggerClassName="btn btn-secondary btn-sm"
          title="Alıcıyı duraklat"
          consequence={
            <>
              <p>
                <strong>{recipient.label}</strong> yeniden etkinleştirilene kadar hiçbir alarm e-postası almaz; bekleyen
                bildirimleri de ona gönderilmez.
              </p>
              <LastCriticalHint recipient={recipient} />
            </>
          }
          confirmLabel="Evet, duraklat"
          tone="primary"
          testId="ops-alert-recipient-pause"
        />
      )}
      <ActionError state={state} testId="ops-alert-recipient-pause-error" />
    </form>
  );
}

function ResumeForm({ recipient }: { recipient: RowRecipient }) {
  const [state, action] = useActionState(resumeRecipientAction, RECIPIENT_ACTION_IDLE);
  return (
    <form action={action} className="inline-form">
      <Target recipient={recipient} />
      <PlainSubmit label="Sürdür" pendingLabel="Kaydediliyor…" testId="ops-alert-recipient-resume" />
      <ActionError state={state} testId="ops-alert-recipient-resume-error" />
    </form>
  );
}

/** A test send asks nothing first; its outcome is announced next to the button. */
function TestSendForm({ recipient }: { recipient: RowRecipient }) {
  const [state, action] = useActionState(testRecipientAction, RECIPIENT_ACTION_IDLE);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="recipientId" value={recipient.id} />
      <PlainSubmit label="Test gönder" pendingLabel="Gönderiliyor…" testId="ops-alert-recipient-test" />
      {state.kind === 'tested' ? (
        <p
          className={state.ok ? 'notice notice-success' : 'notice notice-error'}
          role="status"
          aria-live="polite"
          data-testid="ops-alert-recipient-test-result"
          data-result={state.result}
        >
          {state.message} <code>{state.result}</code>
        </p>
      ) : null}
      <ActionError state={state} testId="ops-alert-recipient-test-error" />
    </form>
  );
}

function PlainSubmit({ label, pendingLabel, testId }: { label: string; pendingLabel: string; testId: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-secondary btn-sm" type="submit" disabled={pending} aria-disabled={pending} data-testid={testId}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * "Göster": a confirmation, then the address in a window of its own. The
 * address is this component's state while that window is open and nothing
 * else; closing it (Kapat, Esc, the backdrop) sets it back to null and only
 * then refreshes the list, so the REVEALED row appears in the recipient log.
 */
function RevealControl({ recipient }: { recipient: RowRecipient }) {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const windowRef = useRef<HTMLDialogElement>(null);

  async function reveal(formData: FormData) {
    setError(null);
    const outcome = await revealRecipientAction(formData);
    if (outcome.kind === 'revealed') {
      setAddress(outcome.address);
      windowRef.current?.showModal();
    } else {
      setError(outcome.message);
    }
  }

  function dropAddress() {
    setAddress(null);
    router.refresh();
  }

  return (
    <form action={reveal} className="inline-form">
      <input type="hidden" name="recipientId" value={recipient.id} />
      <ConfirmDialog
        triggerLabel="Göster"
        proof="ops-alert-recipient.reveal"
        triggerClassName="btn btn-secondary btn-sm"
        title="Adresi açık göster"
        consequence={
          <>
            <p>
              <strong>{recipient.label}</strong> alıcısının tam adresi yalnız açılacak pencerede gösterilir. Her görüntüleme
              alıcı geçmişine kaydedilir.
            </p>
            <p>Pencereyi kapattığınızda adres sayfadan silinir.</p>
          </>
        }
        confirmLabel="Evet, göster"
        tone="primary"
        testId="ops-alert-recipient-reveal"
      />
      {error ? (
        <p className="notice notice-error" role="alert" data-testid="ops-alert-recipient-reveal-error">
          {error}
        </p>
      ) : null}
      <dialog
        ref={windowRef}
        className="confirm-dialog"
        aria-modal="true"
        aria-label="Açık adres"
        onClose={dropAddress}
        onCancel={(event) => event.stopPropagation()}
        onClick={(event) => {
          if (event.target === windowRef.current) windowRef.current?.close();
        }}
        data-testid="ops-alert-recipient-revealed"
      >
        <div className="confirm-dialog-head">
          <h2 className="confirm-dialog-title">Açık adres</h2>
          <button type="button" className="confirm-dialog-close" aria-label="Kapat" onClick={() => windowRef.current?.close()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="confirm-dialog-body">
          <p>
            <strong>{recipient.label}</strong>
          </p>
          {address ? (
            <code className="cell-break" data-testid="ops-alert-recipient-revealed-address">
              {address}
            </code>
          ) : null}
          <p className="cell-muted">Bu görüntüleme kaydedildi. Adresi kopyalayıp başka yere yazmayın.</p>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn btn-primary" onClick={() => windowRef.current?.close()}>
            Kapat
          </button>
        </div>
      </dialog>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The windows the row opens (`?alici=<id>&islem=sil|adres`)
// ---------------------------------------------------------------------------

function ReasonField({ value, onChange, state }: { value: string; onChange: (next: string) => void; state: RecipientActionState }) {
  const problem = state.kind === 'error' && state.field === 'reason' ? state.message : null;
  return (
    <label className="seo-field">
      <span className="seo-field-label">Gerekçe</span>
      <textarea
        name="reason"
        required
        minLength={RECIPIENT_REASON_MIN_LENGTH}
        maxLength={RECIPIENT_REASON_MAX_LENGTH}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={problem ? true : undefined}
        data-testid="ops-alert-recipient-reason"
      />
      <span className="help-text">En az {RECIPIENT_REASON_MIN_LENGTH} karakter. Alıcı geçmişine yazılır; adres yazmayın.</span>
    </label>
  );
}

export function RecipientDeleteForm({ recipient, cancelHref }: { recipient: RowRecipient; cancelHref: string }) {
  const [state, action] = useActionState(deleteRecipientAction, RECIPIENT_ACTION_IDLE);
  // Controlled, so a refusal or the second step keeps the reason that was typed.
  const [reason, setReason] = useState('');
  const stepped = state.kind === 'last-critical' || state.kind === 'last-channel';
  return (
    <form action={action} className="seo-modal-form" data-testid="ops-alert-recipient-delete-form">
      <Target recipient={recipient} />
      <p>
        <strong>{recipient.label}</strong> (<code>{recipient.maskedAddress}</code>) silinir: şifreli adresi kalıcı olarak yok
        edilir ve bekleyen bildirimleri gönderilmez. Bu geri alınamaz.
      </p>
      <ReasonField value={reason} onChange={setReason} state={state} />
      <ActionError state={state} testId="ops-alert-recipient-delete-error" />
      <div className="form-actions">
        {stepped ? (
          <LastCriticalStep
            state={state}
            leadProof="ops-alert-recipient.delete"
            confirmLabel="Yine de sil"
            testId="ops-alert-recipient-delete-last-critical"
          />
        ) : (
          <ConfirmDialog
            triggerLabel="Alıcıyı sil"
            proof="ops-alert-recipient.delete"
            title="Alıcıyı sil"
            consequence={
              <>
                <p>
                  <strong>{recipient.label}</strong> kalıcı olarak silinir ve bir daha alarm e-postası almaz. Bu geri alınamaz.
                </p>
                <LastCriticalHint recipient={recipient} />
              </>
            }
            confirmLabel="Evet, sil"
            testId="ops-alert-recipient-delete"
          />
        )}
        <Link className="btn btn-secondary" href={cancelHref} scroll={false}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}

export function RecipientReplaceForm({ recipient, cancelHref }: { recipient: RowRecipient; cancelHref: string }) {
  const [state, action] = useActionState(replaceRecipientAddressAction, RECIPIENT_ACTION_IDLE);
  // The typed address lives only here; it is never put in a URL, a cookie or storage.
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState('');
  const addressProblem = state.kind === 'error' && state.field === 'address';
  return (
    <form action={action} className="seo-modal-form" data-testid="ops-alert-recipient-replace-form">
      <Target recipient={recipient} />
      <div className="seo-field">
        <span className="seo-field-label">Şu anki adres</span>
        <div className="locked-field">
          <code className="locked-field-value">{recipient.maskedAddress}</code>
        </div>
      </div>
      <label className="seo-field">
        <span className="seo-field-label">Yeni e-posta adresi</span>
        <input
          name="address"
          type="text"
          inputMode="email"
          required
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="ad@sirket.com"
          aria-invalid={addressProblem ? true : undefined}
          data-testid="ops-alert-recipient-new-address"
        />
      </label>
      <ReasonField value={reason} onChange={setReason} state={state} />
      <ActionError state={state} testId="ops-alert-recipient-replace-error" />
      <div className="form-actions">
        <ConfirmDialog
          triggerLabel="Adresi değiştir"
          proof="ops-alert-recipient.replace"
          triggerClassName="btn btn-primary"
          title="Adresi değiştir"
          consequence={
            <p>
              Eski alıcı ve şifreli adresi kalıcı olarak silinir; yerine aynı etiket, bildirim tercihleri ve durumla yeni adresli
              bir alıcı oluşturulur. Eski adrese bekleyen bildirimler gönderilmez.
            </p>
          }
          confirmLabel="Evet, adresi değiştir"
          testId="ops-alert-recipient-replace"
        />
        <Link className="btn btn-secondary" href={cancelHref} scroll={false}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}
