'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';
import {
  REVIEW_REPORT_NOTE_MAX_LENGTH,
  REVIEW_REPORT_REASONS,
  REVIEW_REPORT_REASON_LABELS,
} from '../../../../lib/reviews';
import { reportReviewAction } from './actions';

type ReviewReportDialogProps = {
  providerId: string;
  reviewId: string;
};

/**
 * "Yorumu bildir": the reviewed business flags a comment for the operators.
 *
 * The same native `<dialog>` the request report uses, opened with
 * `showModal()`; the form inside posts the server action the ordinary way, so
 * the report round-trips through the API and the page comes back with the
 * answer as a query flag.
 *
 * What the dialog says before the reason is chosen matters: a report is not
 * a takedown. The comment stays on the profile until an operator reads the
 * report and decides — the business is told so here rather than finding out
 * from the profile afterwards.
 */
export function ReviewReportDialog({ providerId, reviewId }: ReviewReportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = `review-report-title-${reviewId}`;

  return (
    <>
      <button
        type="button"
        className="pdash-btn pdash-btn-ghost pdash-btn-sm"
        onClick={() => dialog.current?.showModal()}
        data-testid="review-report-button"
      >
        Yorumu bildir
      </button>

      <dialog ref={dialog} className="report-dialog" aria-labelledby={titleId}>
        <form action={reportReviewAction} className="pdash-form">
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="reviewId" value={reviewId} />

          <h2 id={titleId}>Yorumu bildir</h2>
          <p>
            Bu yorum hakaret içeriyor, iletişim bilgisi taşıyor, bu işle ilgili değil ya da
            gerçek bir deneyime dayanmıyorsa ekibimize bildirin. Yorum, ekibimiz inceleyip karar
            verene kadar profilinizde kalır; bildiriminiz yalnız ekibimiz tarafından görülür.
          </p>

          <label className="pdash-form-row">
            <span>Bildirim nedeni *</span>
            <select name="reason" required defaultValue="" data-testid="review-report-reason">
              <option value="" disabled>
                Seçiniz
              </option>
              {REVIEW_REPORT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {REVIEW_REPORT_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>

          <label className="pdash-form-row">
            <span>Not</span>
            <textarea
              name="note"
              rows={3}
              maxLength={REVIEW_REPORT_NOTE_MAX_LENGTH}
              placeholder="İsteğe bağlı: ekibimize iletmek istediğiniz ayrıntı"
              data-testid="review-report-note"
            />
            <small>En fazla {REVIEW_REPORT_NOTE_MAX_LENGTH} karakter.</small>
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
      data-testid="review-report-submit"
    >
      {pending ? 'Gönderiliyor…' : 'Bildir'}
    </button>
  );
}
