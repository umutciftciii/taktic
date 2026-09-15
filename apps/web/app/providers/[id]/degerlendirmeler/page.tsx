import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  getCurrentUser,
  PROVIDER_REVIEW_PUBLIC_MIN_COUNT,
  reviewReportReasonLabel,
  reviewReportResolutionLabel,
  type ProviderReviewItem,
  type ProviderReviewsPage,
} from '../../../../lib/api';
import { ReviewStars } from '../../../review-stars';
import { ReviewSummaryCard } from '../../../review-summary-card';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';
import { ReviewReportDialog } from './report-dialog';

type ProviderReviewsPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ cursor?: string; reported?: string; reportError?: string }>;
};

const REPORT_ERROR_MESSAGES: Record<string, string> = {
  exists: 'Bu yorum için açık bir bildiriminiz zaten var. Ekibimiz karar verdiğinde burada görünür.',
  limit: 'Günlük bildirim sınırına ulaştınız. Lütfen yarın tekrar deneyin.',
  'not-reportable': 'Bu değerlendirmede bildirilecek bir yorum yok ya da yorum zaten kaldırıldı.',
};

/**
 * The provider's own reviews: every live one, newest first, with the
 * business's figures above them.
 *
 * Nothing here names a customer. A row carries the job — its number and its
 * category — the stars, the comment and the business's own report on it; the
 * reviewer is the API's secret and the screen has no field to put them in.
 *
 * The figures are the exact ones, not the public projection: three reviews
 * is the public threshold, but one review is a fact on the business's own
 * screen, and the sentence beside the figures says when the profile will
 * start showing them.
 */
export default async function ProviderReviewsPage({ params, searchParams }: ProviderReviewsPageProps) {
  const { id } = await params;
  const { cursor, reported, reportError } = (await searchParams) ?? {};

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/degerlendirmeler`);
  }

  const query = new URLSearchParams({ limit: '20' });
  if (cursor?.trim()) query.set('cursor', cursor.trim());

  const [page, creditBalance] = await Promise.all([
    // A 403 from ProviderAccessGuard is another provider's panel, and that is
    // the shared 404 rather than an error boundary — the same rule as the
    // offers screen beside this one.
    fetchOrNotFound(() =>
      apiFetch<ProviderReviewsPage>(`/providers/${id}/reviews?${query.toString()}`),
    ),
    readCreditBalance(id),
  ]);

  const reportErrorMessage = reportError ? (REPORT_ERROR_MESSAGES[reportError] ?? null) : null;
  const publicVisible = page.summary.count >= PROVIDER_REVIEW_PUBLIC_MIN_COUNT;

  return (
    <ProviderShell user={user} providerId={id} active="reviews" creditBalance={creditBalance}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Değerlendirmeler</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Müşteri görüşleri</span>
        <h1 className="pdash-page-title">Değerlendirmeler</h1>
        <p className="pdash-page-sub">
          Tamamlanan işlerinizin ardından müşterilerinizin bıraktığı puanlar ve yorumlar.
          Müşteri adı ve iletişim bilgisi hiçbir zaman gösterilmez.
        </p>
      </header>

      {reported ? (
        <div className="pdash-notice" role="status" data-testid="review-report-received">
          Bildiriminiz alındı. Ekibimiz inceleyene kadar yorum profilinizde görünmeye devam eder;
          karar verildiğinde bu listede görünür.
        </div>
      ) : null}
      {reportErrorMessage ? (
        <div className="pdash-notice pdash-notice-error" role="status" data-testid="review-report-error">
          {reportErrorMessage}
        </div>
      ) : null}

      <div className="split">
        <div className="split-main">
          <div className="pdash-section-head">
            <h2 className="pdash-section-title">
              <span>Değerlendirmeler</span>
              <span className="pdash-section-count" data-testid="review-count">
                {page.summary.count}
              </span>
            </h2>
          </div>

          {page.items.length === 0 ? (
            <div className="pdash-empty" data-testid="review-empty">
              <h3>Henüz değerlendirme yok</h3>
              <p>
                Bir müşteri, kabul ettiği teklifinizin işini tamamlandı olarak işaretledikten sonra
                sizi değerlendirebilir. Değerlendirmeler burada listelenir.
              </p>
            </div>
          ) : (
            <ul className="review-list">
              {page.items.map((item) => (
                <ReviewRow key={item.id} providerId={id} item={item} />
              ))}
            </ul>
          )}

          {page.nextCursor ? (
            <div className="inline-actions" style={{ marginTop: 16 }}>
              <Link
                className="pdash-btn pdash-btn-secondary"
                href={`/providers/${id}/degerlendirmeler?cursor=${encodeURIComponent(page.nextCursor)}`}
              >
                Daha fazla
              </Link>
            </div>
          ) : null}
        </div>

        <aside className="split-rail" aria-label="Değerlendirme özeti">
          <div className="rail-panel">
            <span className="rail-title">Puan özeti</span>
            <ReviewSummaryCard summary={page.summary} />
          </div>
          <div className="rail-note" data-testid="review-public-note">
            {publicVisible ? (
              <>
                <strong>Profilinizde görünüyor.</strong> Herkese açık profilinizde ortalama puan ve
                değerlendirme sayısı gösteriliyor.
              </>
            ) : (
              <>
                <strong>Herkese açık profil.</strong> Ortalama puanınız, en az{' '}
                {PROVIDER_REVIEW_PUBLIC_MIN_COUNT} değerlendirme olduğunda herkese açık profilinizde
                görünür.
              </>
            )}
          </div>
          <div className="rail-note">
            <strong>Uygunsuz yorum mu?</strong> Bir yorumu bildirdiğinizde ekibimiz inceler; karar
            verilene kadar yorum yayında kalır. Puanlar kredi, teklif sıralaması ya da vitrin
            hakkınızı etkilemez.
          </div>
        </aside>
      </div>
    </ProviderShell>
  );
}

function ReviewRow({ providerId, item }: { providerId: string; item: ProviderReviewItem }) {
  const reference = item.request.requestNumber ?? `#${item.request.id.slice(-6).toUpperCase()}`;
  const report = item.myReport;
  // A report is "open" until it carries a resolution. A resolved one is history
  // and a new report may be filed — but only while there is still a comment
  // to report, which the API decides; the button is offered on the same rule.
  const openReport = report && report.resolution === null ? report : null;
  const canReport = item.comment !== null && !item.commentRemoved && openReport === null;

  return (
    <li className="review-row" data-testid="review-row" data-review-id={item.id}>
      <div className="review-row-head">
        <ReviewStars value={item.rating} />
        <span className="tag tag-neutral">{item.request.categoryName}</span>
        <span className="review-row-meta">
          {reference} · {formatDateTime(item.createdAt)}
        </span>
      </div>

      {item.commentRemoved ? (
        <p className="review-row-removed" data-testid="review-row-comment-removed">
          Yorum yönetim tarafından kaldırıldı; puan geçerliliğini korur.
        </p>
      ) : item.comment ? (
        <p className="review-row-comment" data-testid="review-row-comment">
          {item.comment}
        </p>
      ) : (
        <p className="review-row-removed">Müşteri yorum yazmadı.</p>
      )}

      <div className="review-row-actions">
        {openReport ? (
          <span className="tag tag-accent" data-testid="review-row-report-open">
            Bildirildi · inceleniyor ({reviewReportReasonLabel(openReport.reason)})
          </span>
        ) : report ? (
          <span className="tag tag-neutral" data-testid="review-row-report-resolved">
            {reviewReportResolutionLabel(report.resolution ?? '')}
          </span>
        ) : null}
        {canReport ? <ReviewReportDialog providerId={providerId} reviewId={item.id} /> : null}
      </div>
    </li>
  );
}
