'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';
import {
  REQUEST_REPORT_NOTE_MAX_LENGTH,
  REQUEST_REPORT_REASONS,
  REQUEST_REPORT_REASON_LABELS,
} from '../../../../../lib/request-reports';
import { reportRequestAction } from './actions';

type ReportDialogProps = {
  providerId: string;
  requestId: string;
  /**
   * The screen the dialog sits on, for the action to come back to. Omitted on
   * the request detail itself; the vitrin lead screen names its own path.
   */
  returnTo?: string;
};

/**
 * "Talebi bildir": a provider flags a request for the operators.
 *
 * A native `<dialog>` opened with `showModal()`, after the card menu's
 * precedent. The form inside posts the server action the ordinary way — no
 * `method="dialog"`, which would close it instead of submitting — so the
 * report round-trips through the API and the page comes back with the answer
 * as a query flag, exactly like the offer form beside it.
 *
 * What is not here: who else reported the request, or what happened to a
 * previous report. The provider sees their own report and nothing more.
 */
export function ReportDialog({ providerId, requestId, returnTo }: ReportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="pdash-btn pdash-btn-ghost pdash-btn-sm"
        onClick={() => dialog.current?.showModal()}
        data-testid="report-request-button"
      >
        Talebi bildir
      </button>

      <dialog ref={dialog} className="report-dialog" aria-labelledby="report-dialog-title">
        <form action={reportRequestAction} className="pdash-form">
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="requestId" value={requestId} />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}

          <h2 id="report-dialog-title">Talebi bildir</h2>
          <p>
            Bu talep spam, deneme, yanlış kategoride ya da iletişim bilgisi içeriyorsa ekibimize
            bildirin. Bildiriminiz yalnızca ekibimiz tarafından görülür.
          </p>

          <label className="pdash-form-row">
            <span>Bildirim nedeni *</span>
            <select name="reason" required defaultValue="" data-testid="report-reason">
              <option value="" disabled>
                Seçiniz
              </option>
              {REQUEST_REPORT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {REQUEST_REPORT_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>

          <label className="pdash-form-row">
            <span>Not</span>
            <textarea
              name="note"
              rows={3}
              maxLength={REQUEST_REPORT_NOTE_MAX_LENGTH}
              placeholder="İsteğe bağlı: ekibimize iletmek istediğiniz ayrıntı"
              data-testid="report-note"
            />
            <small>En fazla {REQUEST_REPORT_NOTE_MAX_LENGTH} karakter.</small>
          </label>

          <div className="pdash-actions" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="pdash-btn pdash-btn-ghost"
              onClick={() => dialog.current?.close()}
            >
              Vazgeç
            </button>
            <SubmitButton />
          </div>
        </form>
      </dialog>
    </>
  );
}

/** Held while the action runs, so a double click cannot post two reports. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="pdash-btn pdash-btn-primary"
      disabled={pending}
      aria-busy={pending || undefined}
      data-testid="report-submit"
    >
      {pending ? 'Gönderiliyor…' : 'Bildir'}
    </button>
  );
}
