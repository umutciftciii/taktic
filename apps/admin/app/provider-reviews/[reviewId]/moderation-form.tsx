'use client';

import { useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import {
  REVIEW_REASON_ADMIN_LABELS,
  REVIEW_REASON_CUSTOMER_LABELS,
  REVIEW_REPORT_REASON_KEYS,
  type ReviewModerationAction,
} from '../../../lib/reviews';
import { moderateReviewAction } from './actions';

type ReviewModerationFormProps = {
  reviewId: string;
  /** Whether there is a comment that could still be taken down. */
  hasLiveComment: boolean;
  removed: boolean;
  commentRemoved: boolean;
  /** Whether a report is open: a removal closes it, and the dialog says so. */
  hasOpenReport: boolean;
};

const ACTION_COPY: Record<
  ReviewModerationAction,
  { button: string; title: string; hint: string; submit: string; className: string }
> = {
  REMOVE_COMMENT: {
    button: 'Yorumu kaldır',
    title: 'Yorumu kaldır',
    hint: 'Yalnız yorum metni kaldırılır; yıldız ortalamada kalır. Müşteriye seçilen gerekçe bildirilir. Açık bildirim "Yorum kaldırıldı" olarak kapanır.',
    submit: 'Yorumu kaldır',
    className: 'btn btn-secondary btn-sm',
  },
  REMOVE_REVIEW: {
    button: 'Değerlendirmeyi kaldır',
    title: 'Değerlendirmeyi kaldır',
    hint: 'Yıldız ve yorum birlikte kaldırılır; ortalama anında düşer. Müşteriye seçilen gerekçe bildirilir. Açık bildirim "Değerlendirme kaldırıldı" olarak kapanır.',
    submit: 'Değerlendirmeyi kaldır',
    className: 'btn btn-danger btn-sm',
  },
  RESTORE: {
    button: 'Geri getir',
    title: 'Geri getir',
    hint: 'Kaldırılan yorum ve/veya değerlendirme geri gelir; ortalama yeniden hesaplanır. Müşteriye mail gitmez; kapanmış bildirimler değişmez.',
    submit: 'Geri getir',
    className: 'btn btn-secondary btn-sm',
  },
};

/**
 * What a removal really does, read off `ProviderReviewModerationService.moderate`
 * and `TransactionalMailService.sendReviewRemoved`: one transaction stamps the
 * review, appends the log row and closes any open report; the customer is
 * mailed after the commit, and only when the request carries an address.
 */
function removalConsequence(action: 'REMOVE_COMMENT' | 'REMOVE_REVIEW', hasOpenReport: boolean): ReactNode {
  return (
    <ul>
      {action === 'REMOVE_COMMENT' ? (
        <li>
          Yorum metni işletme profilinden kalkar. <strong>Yıldız yayında ve ortalamada kalır.</strong>
        </li>
      ) : (
        <li>
          Yıldız ve yorum profilden birlikte kalkar; <strong>puan ortalaması ve değerlendirme sayısı hemen yeniden
          hesaplanır.</strong>
        </li>
      )}
      <li>
        Müşteriye, talepte e-posta adresi varsa, seçtiğiniz gerekçenin müşteri metniyle e-posta gider. Bildirimi
        yapan işletme ve notunuz müşteriye söylenmez.
      </li>
      {hasOpenReport ? (
        <li>
          Açık bildirim “{action === 'REMOVE_COMMENT' ? 'Yorum kaldırıldı' : 'Değerlendirme kaldırıldı'}” kararıyla
          kapanır.
        </li>
      ) : null}
      <li>
        Karar moderasyon günlüğüne adınızla yazılır. “Geri getir” ile geri alınabilir; gönderilmiş e-posta geri
        alınamaz.
      </li>
    </ul>
  );
}

/**
 * The operator's three decisions on a review, as three buttons that open the
 * matching form. Only the decisions that make sense for the review's current
 * state are offered: a removed review offers "Geri getir", a live one offers
 * the two removals, and a review whose comment is already gone offers only
 * the whole removal and the restore.
 *
 * A removal demands a reason, which is the one thing the customer is told —
 * the select shows the operator's wording and, beside it, the sentence the
 * customer will read, so the choice is made with both in view. Both removals
 * then ask once more in a dialog that says what the API will do (the customer
 * is mailed); closing it with Esc, Vazgeç or × submits nothing. A restore
 * mails nobody and is itself undone by a removal, so it does not ask.
 */
export function ReviewModerationForm({
  reviewId,
  hasLiveComment,
  removed,
  commentRemoved,
  hasOpenReport,
}: ReviewModerationFormProps) {
  const [open, setOpen] = useState<ReviewModerationAction | null>(null);

  const available: ReviewModerationAction[] = removed
    ? ['RESTORE']
    : [
        ...(hasLiveComment ? (['REMOVE_COMMENT'] as const) : []),
        'REMOVE_REVIEW',
        ...(commentRemoved ? (['RESTORE'] as const) : []),
      ];

  return (
    <div className="report-decisions" data-testid="review-moderation">
      <div className="inline-actions">
        {available.map((action) => (
          <button
            key={action}
            type="button"
            className={open === action ? 'btn btn-primary btn-sm' : ACTION_COPY[action].className}
            aria-pressed={open === action}
            onClick={() => setOpen((current) => (current === action ? null : action))}
            data-testid={`moderate-${action}`}
          >
            {ACTION_COPY[action].button}
          </button>
        ))}
      </div>

      {open ? (
        <form
          action={moderateReviewAction}
          className="status-reject-form report-decision-form"
          data-testid="moderation-form"
          style={{ marginTop: 12 }}
        >
          <input type="hidden" name="reviewId" value={reviewId} />
          <input type="hidden" name="action" value={open} />
          <fieldset className="report-remove-fieldset">
            <legend>{ACTION_COPY[open].title}</legend>
            <p className="report-decision-hint">{ACTION_COPY[open].hint}</p>

            {open !== 'RESTORE' ? (
              <label className="status-reject-field">
                <span>Gerekçe (zorunlu; müşteriye gösterilecek metin yanında)</span>
                <select name="reason" required defaultValue="" data-testid="moderation-reason">
                  <option value="" disabled>
                    Gerekçe seçin
                  </option>
                  {REVIEW_REPORT_REASON_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {REVIEW_REASON_ADMIN_LABELS[key]} — “{REVIEW_REASON_CUSTOMER_LABELS[key]}”
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="status-reject-field">
              <span>Not (opsiyonel, yalnız yönetici görür)</span>
              <textarea name="note" placeholder="Karar gerekçesi" data-testid="moderation-note" />
            </label>

            <div className="inline-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
                Vazgeç
              </button>
              {open === 'RESTORE' ? (
                <SubmitButton label={ACTION_COPY[open].submit} />
              ) : (
                <ConfirmDialog
                  triggerLabel={ACTION_COPY[open].submit}
                  triggerClassName={open === 'REMOVE_REVIEW' ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'}
                  title={open === 'REMOVE_REVIEW' ? 'Değerlendirme kaldırılsın mı?' : 'Yorum kaldırılsın mı?'}
                  consequence={removalConsequence(open, hasOpenReport)}
                  confirmLabel={open === 'REMOVE_REVIEW' ? 'Evet, değerlendirmeyi kaldır' : 'Evet, yorumu kaldır'}
                  tone={open === 'REMOVE_REVIEW' ? 'danger' : 'primary'}
                  testId="moderation-submit"
                />
              )}
            </div>
          </fieldset>
        </form>
      ) : null}
    </div>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-sm"
      disabled={pending}
      aria-busy={pending || undefined}
      data-testid="moderation-submit"
    >
      {pending ? 'Kaydediliyor…' : label}
    </button>
  );
}
