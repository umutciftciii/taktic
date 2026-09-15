import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDate,
  formatDateTime,
  getCurrentUser,
  PROVIDER_REVIEW_WINDOW_DAYS,
  reviewRemovalReasonLabel,
  type CustomerReviewState,
} from '../../../../lib/api';
import { IconArrowLeft } from '../../../landing-icons';
import { ReviewStars } from '../../../review-stars';
import { CustomerShell } from '../../customer-shell';
import type { ReviewSubmitStatus } from './actions';
import { ReviewForm } from './review-form';

type ReviewPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ review?: string }>;
};

/**
 * What the page says about the last submission, keyed by the action's status
 * word. "ok" is not here: a successful submission re-renders as the
 * already-reviewed state below, which is its own confirmation.
 */
const SUBMIT_MESSAGES: Partial<Record<ReviewSubmitStatus, string>> = {
  contact:
    'Yorumunuzda iletişim bilgisi (telefon, e-posta, bağlantı) bulundu. Bu bilgileri çıkarıp tekrar deneyin.',
  closed: 'Değerlendirme süresi doldu; bu iş artık değerlendirilemiyor.',
  exists: 'Bu iş için değerlendirmeniz zaten kaydedilmişti.',
  invalid: 'Değerlendirme kaydedilemedi: 1 ile 5 arasında bir puan seçin ve yorumu kısaltın.',
  failed: 'Değerlendirme şu anda kaydedilemedi. Lütfen daha sonra tekrar deneyin.',
};

/**
 * The customer rates the provider whose offer they accepted, once, after the
 * job is marked done.
 *
 * Every verdict on this screen is the API's. The page asks for the customer's
 * review state and renders the answer — the form when they may still write
 * one, their review once they have, and a plain sentence for the rest. It
 * decides nothing itself: not who the provider is (the API reads it off the
 * accepted offer), not whether the window is open, not whether a review
 * already exists.
 *
 * Two answers deliberately look like "this page does not exist". Another
 * customer's request is a 403 from the API and a 404 here, because confirming
 * that the request exists would be a disclosure. And a request whose review
 * feature is off is a 404 too: with the switch off there is no review
 * screen, and a link that landed here from an old e-mail should say so
 * rather than render a form that cannot be posted.
 */
export default async function CustomerReviewPage({ params, searchParams }: ReviewPageProps) {
  const { id } = await params;
  const { review: submitStatus } = (await searchParams) ?? {};

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/degerlendir`);
  }

  const state = await fetchOrNotFound(() =>
    apiFetch<CustomerReviewState>(`/service-requests/${id}/review`),
  );

  if (state.eligibility === 'disabled') {
    notFound();
  }

  const message = submitStatus ? (SUBMIT_MESSAGES[submitStatus as ReviewSubmitStatus] ?? null) : null;
  const businessName = state.provider?.businessName ?? 'Hizmet veren';

  return (
    <CustomerShell user={user} active="offers">
      <Link className="cdash-page-back" href={`/requests/${id}/offers`}>
        <IconArrowLeft size={14} />
        <span>Talebe dön</span>
      </Link>

      <header className="cdash-page-head">
        <span className="kicker">Değerlendirme</span>
        <h1 className="cdash-page-title">{businessName}</h1>
        <p className="cdash-page-sub">
          Tamamlanan işiniz için hizmet vereni değerlendirin. Puanınız işletmenin herkese açık
          profilinde, adınız olmadan gösterilir.
        </p>
      </header>

      {message ? (
        <div
          className="cdash-notice cdash-notice-error"
          role="status"
          data-testid="review-notice"
          style={{ marginBottom: 16 }}
        >
          {message}
        </div>
      ) : null}

      <section className="cdash-summary review-panel" data-testid="review-panel" data-state={state.eligibility}>
        <div className="cdash-summary-main">
          <ReviewBody requestId={id} state={state} businessName={businessName} contactRefused={submitStatus === 'contact'} />
        </div>
      </section>
    </CustomerShell>
  );
}

function ReviewBody({
  requestId,
  state,
  businessName,
  contactRefused,
}: {
  requestId: string;
  state: CustomerReviewState;
  businessName: string;
  contactRefused: boolean;
}) {
  const review = state.review;

  switch (state.eligibility) {
    case 'ok':
      return (
        <>
          {state.windowEndsAt ? (
            <p className="cdash-summary-body" data-testid="review-window">
              Değerlendirme {formatDate(state.windowEndsAt)} tarihine kadar yapılabilir.
            </p>
          ) : null}
          <ReviewForm requestId={requestId} businessName={businessName} contactRefused={contactRefused} />
        </>
      );

    case 'already-reviewed':
      return review ? (
        <div data-testid="review-done">
          <span className="cdash-summary-label">Değerlendirmeniz</span>
          <div className="review-done-head">
            <ReviewStars value={review.rating} />
            <span className="cdash-offer-sub">{formatDateTime(review.createdAt)}</span>
          </div>
          {review.commentRemoved ? (
            <p className="cdash-card-note" data-testid="review-comment-removed">
              Yorumunuz yönetim tarafından kaldırıldı
              {review.removalReason ? ` — gerekçe: ${reviewRemovalReasonLabel(review.removalReason)}` : ''}.
              Puanınız geçerliliğini korur.
            </p>
          ) : review.comment ? (
            <p className="review-comment" data-testid="review-comment-text">
              {review.comment}
            </p>
          ) : (
            <p className="cdash-summary-body">Yorum yazmadınız.</p>
          )}
          <p className="cdash-summary-body">
            Değerlendirmeniz için teşekkürler. Bir iş yalnız bir kez değerlendirilebilir.
          </p>
        </div>
      ) : null;

    case 'removed':
      return (
        <div data-testid="review-removed">
          <span className="cdash-summary-label">Değerlendirmeniz</span>
          <p className="cdash-summary-body">
            Değerlendirmeniz yönetim tarafından kaldırıldı
            {review?.removalReason ? ` — gerekçe: ${reviewRemovalReasonLabel(review.removalReason)}` : ''}.
            İtiraz etmek için <Link href="/destek">destek talebi</Link> açabilirsiniz.
          </p>
        </div>
      );

    case 'not-completed':
      return (
        <div data-testid="review-not-completed">
          <p className="cdash-summary-body">
            Değerlendirme, iş tamamlandı olarak işaretlendikten sonra yapılabilir. Kabul ettiğiniz
            teklif tamamlandığında talep sayfasından &ldquo;Hizmet tamamlandı&rdquo; düğmesini
            kullanın.
          </p>
          <Link className="cdash-btn cdash-btn-secondary" href={`/requests/${requestId}/offers`}>
            Teklifleri gör
          </Link>
        </div>
      );

    case 'window-closed':
      return (
        <div data-testid="review-window-closed">
          <p className="cdash-summary-body">
            Değerlendirme süresi doldu. Bir iş, tamamlandıktan sonra {PROVIDER_REVIEW_WINDOW_DAYS}{' '}
            gün içinde değerlendirilebilir
            {state.windowEndsAt ? `; bu işin süresi ${formatDate(state.windowEndsAt)} tarihinde sona erdi` : ''}.
          </p>
        </div>
      );

    default:
      return null;
  }
}
