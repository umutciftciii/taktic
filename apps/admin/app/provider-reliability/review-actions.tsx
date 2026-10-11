import { ConfirmDialog } from '../../components/confirm-dialog';
import { RATIONALE_MAX_LENGTH, RATIONALE_MIN_LENGTH, type ReliabilityReview } from '../../lib/service-incidents';

type FormAction = (formData: FormData) => void | Promise<void>;

export type ReviewFormActions = { acknowledge: FormAction; resolve: FormAction };

/**
 * REL-002 Faz 4 — Üstlen and Sonuçlandır on one unresolved reliability review,
 * for an operator holding PROVIDER_RELIABILITY_MANAGE (the caller decides
 * whether to render this at all).
 *
 * Neither control touches the provider's account. There is deliberately no
 * suspension here: that is the provider screen's own moderation flow.
 * The form actions are passed in, so this renders on its own in a test.
 */
export function ReviewActions({
  review,
  providerName,
  from,
  filter,
  formActions,
}: {
  review: Pick<ReliabilityReview, 'id' | 'providerId' | 'status'>;
  providerName: string;
  /** Where the operator goes back to: the queue, or the provider's card. */
  from: 'queue' | 'provider';
  /** The queue's current filter, kept across the round trip. */
  filter?: string;
  formActions: ReviewFormActions;
}) {
  if (review.status === 'RESOLVED') return null;
  const noteId = `review-note-${review.id}`;
  const hidden = (
    <>
      <input type="hidden" name="reviewId" value={review.id} />
      <input type="hidden" name="providerId" value={review.providerId} />
      <input type="hidden" name="from" value={from} />
      {filter ? <input type="hidden" name="filter" value={filter} /> : null}
    </>
  );

  return (
    <div className="refund-action-stack" data-testid="reliability-review-actions">
      {review.status === 'OPEN' ? (
        <form action={formActions.acknowledge}>
          {hidden}
          <ConfirmDialog
            proof="reliability-review.acknowledge"
            triggerLabel="Üstlen"
            triggerClassName="btn btn-secondary btn-sm"
            tone="primary"
            title="İnceleme üstlenilsin mi?"
            consequence={
              <>
                <p>
                  {providerName} için açılan güvenilirlik incelemesi “Üstlenildi” olur ve üstlenen olarak adınız
                  kaydedilir.
                </p>
                <p>Hizmet verenin hesabı, teklifleri ve işleri değişmez; hizmet verene bildirim gitmez.</p>
              </>
            }
            confirmLabel="Evet, üstlen"
            testId="review-acknowledge"
          />
        </form>
      ) : null}

      <form action={formActions.resolve} className="refund-action detail-form">
        {hidden}
        <label className="detail-form-field" htmlFor={noteId}>
          <span>
            Sonuç notu ({RATIONALE_MIN_LENGTH}–{RATIONALE_MAX_LENGTH} karakter, yalnız iç kayıt)
          </span>
          <textarea
            id={noteId}
            name="note"
            rows={2}
            required
            minLength={RATIONALE_MIN_LENGTH}
            maxLength={RATIONALE_MAX_LENGTH}
            data-testid="review-note"
          />
        </label>
        <div className="detail-form-actions">
          <ConfirmDialog
            proof="reliability-review.resolve"
            triggerLabel="Sonuçlandır"
            triggerClassName="btn btn-primary btn-sm"
            tone="primary"
            title="İnceleme sonuçlandırılsın mı?"
            consequence={
              <>
                <p>
                  İnceleme “Sonuçlandı” olur; notunuz adınızla birlikte kaydedilir ve geri alınamaz.
                </p>
                <p>
                  Hizmet verenin hesabı askıya alınmaz ve değişmez. Askıya alma gerekiyorsa hizmet verenin kendi
                  sayfasındaki durum yönetiminden yapılır.
                </p>
              </>
            }
            confirmLabel="Evet, sonuçlandır"
            testId="review-resolve"
          />
        </div>
      </form>
    </div>
  );
}
