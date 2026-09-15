'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { detectContactDetails } from '@taktic/shared';
import { CONTACT_DETAILS_ERROR, CONTACT_DETAILS_HINT } from '../../../../lib/contact-details-refusal';
import { PROVIDER_REVIEW_COMMENT_MAX_LENGTH } from '../../../../lib/reviews';
import { submitReviewAction } from './actions';

/** Where the counter starts warning. Presentational; the limit is the rule. */
const COMMENT_NEAR_LIMIT_AT = PROVIDER_REVIEW_COMMENT_MAX_LENGTH - 60;

const RATING_WORDS: Record<number, string> = {
  1: 'Çok kötü',
  2: 'Kötü',
  3: 'Orta',
  4: 'İyi',
  5: 'Çok iyi',
};

type ReviewFormProps = {
  requestId: string;
  businessName: string;
  /** True when the API refused the last submission for contact details in the comment. */
  contactRefused: boolean;
};

/**
 * The review form: a required star rating, an optional comment.
 *
 * The rating is five native radio buttons in a fieldset, so the keyboard
 * contract is the browser's — arrows move between stars, Space picks one —
 * and the form cannot be posted without one (`required` on the group). The
 * stars are labels for those radios, not buttons that mimic them.
 *
 * The comment stays uncontrolled — the server action reads the posted field —
 * and only its length is mirrored into state for the counter. The live hint
 * runs the same contact detector the API runs, so the hint and the refusal
 * agree; it never blocks, because the server is the rule.
 */
export function ReviewForm({ requestId, businessName, contactRefused }: ReviewFormProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [length, setLength] = useState(0);
  const [contactHint, setContactHint] = useState(false);

  const atLimit = length >= PROVIDER_REVIEW_COMMENT_MAX_LENGTH;
  const nearLimit = !atLimit && length > COMMENT_NEAR_LIMIT_AT;
  const counterStatus = atLimit
    ? 'Karakter sınırına ulaştınız'
    : nearLimit
      ? 'Sınıra yaklaşıyorsunuz'
      : null;

  return (
    <form action={submitReviewAction} className="review-form" data-testid="review-form">
      <input type="hidden" name="requestId" value={requestId} />

      <fieldset className="review-rating-field">
        <legend>Puanınız *</legend>
        <p className="review-rating-help" id="review-rating-help">
          {businessName} işletmesinden aldığınız hizmeti 1 ile 5 yıldız arasında puanlayın.
        </p>
        <div className="review-rating-stars" role="radiogroup" aria-describedby="review-rating-help">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className={`review-rating-option${rating !== null && n <= rating ? ' is-on' : ''}`}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                required
                checked={rating === n}
                onChange={() => setRating(n)}
                data-testid={`rating-${n}`}
                aria-label={`${n} yıldız — ${RATING_WORDS[n]}`}
              />
              <span aria-hidden="true">★</span>
            </label>
          ))}
        </div>
        <p className="review-rating-word" aria-live="polite" data-testid="review-rating-word">
          {rating ? `${rating} yıldız — ${RATING_WORDS[rating]}` : 'Bir yıldız seçin'}
        </p>
      </fieldset>

      <label className="form-row">
        <span>Yorumunuz</span>
        <textarea
          name="comment"
          rows={5}
          maxLength={PROVIDER_REVIEW_COMMENT_MAX_LENGTH}
          placeholder="İsteğe bağlı: işin nasıl gittiğini kısaca anlatın."
          aria-describedby="review-comment-help review-comment-counter"
          aria-invalid={contactRefused ? true : undefined}
          data-testid="review-comment"
          onChange={(event) => {
            setLength(event.target.value.length);
            setContactHint(detectContactDetails(event.target.value) !== null);
          }}
        />
      </label>
      {contactRefused ? (
        <p className="field-error" role="alert" data-testid="review-contact-error">
          {CONTACT_DETAILS_ERROR}
        </p>
      ) : null}
      <p className="field-hint" role="status" data-testid="review-contact-hint">
        {contactHint && !contactRefused
          ? `${CONTACT_DETAILS_HINT}: yorumda telefon, e-posta ya da bağlantı bulunamaz.`
          : null}
      </p>
      <div className="description-meta">
        <span className="help-text" id="review-comment-help">
          Adınız, telefonunuz ve e-postanız paylaşılmaz; yorumunuz işletmenin herkese açık
          profilinde anonim olarak görünebilir.
        </span>
        <p
          className="description-counter"
          id="review-comment-counter"
          data-testid="review-comment-counter"
          data-state={atLimit ? 'limit' : nearLimit ? 'near' : 'ok'}
        >
          <span className="description-counter-count">
            {length} / {PROVIDER_REVIEW_COMMENT_MAX_LENGTH}
            <span className="visually-hidden"> karakter kullanıldı</span>
          </span>
          <span className="description-counter-status" role="status">
            {counterStatus}
          </span>
        </p>
      </div>

      <div className="inline-actions" style={{ marginTop: 16 }}>
        <SubmitButton />
      </div>
    </form>
  );
}

/** Held while the action runs, so a double click cannot post twice. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="cdash-btn cdash-btn-primary"
      disabled={pending}
      aria-busy={pending || undefined}
      data-testid="review-submit"
    >
      {pending ? 'Gönderiliyor…' : 'Değerlendirmeyi gönder'}
    </button>
  );
}
