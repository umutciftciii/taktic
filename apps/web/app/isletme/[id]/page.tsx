import { serviceAreaLabel } from '@taktic/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  monthLabel,
  PROVIDER_REVIEW_PUBLIC_MIN_COUNT,
  type ProviderProfile,
  type PublicReviewsPage,
} from '../../../lib/api';
import { RatingSummaryLine, ReviewStars } from '../../review-stars';

type PublicProviderPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ cursor?: string }>;
};

/**
 * The fields this page reads, and the only ones. The API's public projection
 * is exactly these; a signed-in owner or operator gets their full record from
 * the same route, and this page still renders nothing outside this shape.
 */
type PublicProviderCard = Pick<
  ProviderProfile,
  'id' | 'businessName' | 'city' | 'district' | 'description' | 'status' | 'serviceCategories' | 'serviceAreas'
>;

export async function generateMetadata({ params }: PublicProviderPageProps): Promise<Metadata> {
  const { id } = await params;
  const provider = await loadPublicProvider(id);
  return provider
    ? { title: `${provider.businessName} — TakTick`, robots: { index: true, follow: true } }
    : { title: 'İşletme bulunamadı — TakTick', robots: { index: false } };
}

/**
 * A business's public page: who they are, where they work, and what
 * customers said.
 *
 * ## Who is visible
 *
 * Only an approved business. The API answers 404 to a visitor for anything
 * else — a draft, an application, a rejected or suspended profile — so an
 * unlistable business is indistinguishable from a non-existent one. The
 * owner and an operator get their full record from the same route whatever
 * its status; this page checks the status again so that the same URL shows
 * the same answer to everybody, and reads only the public fields either way.
 *
 * ## What is on it
 *
 * The business card: name, base, description, services, areas. Nothing that
 * reaches a person — no contact name, telephone or e-mail; contact opens
 * through an accepted offer and through nothing else.
 *
 * The reviews, as the API's public list gives them: the summary line, then
 * each comment with its stars, month and category — never a day, never a
 * name. Below three live reviews the API sends a null summary and no items,
 * and the section says so in one sentence. With the feature off the list
 * answers 404 and the section is simply absent: the profile is the same page
 * it was before reviews existed.
 */
export default async function PublicProviderPage({ params, searchParams }: PublicProviderPageProps) {
  const { id } = await params;
  const { cursor } = (await searchParams) ?? {};

  const provider = await loadPublicProvider(id);
  if (!provider) {
    notFound();
  }

  const reviews = await loadPublicReviews(id, cursor?.trim() || null);

  return (
    <main className="lp-section">
      <div className="lp-container">
        <nav className="pdash-crumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>İşletme</span>
        </nav>

        <header className="lp-section-head">
          <span className="kicker">Hizmet veren</span>
          <h1 className="lp-section-title" data-testid="public-provider-name">
            {provider.businessName}
          </h1>
          <p className="lp-section-sub">
            {provider.city}
            {provider.district ? `, ${provider.district}` : ''}
          </p>
          {reviews ? (
            <RatingSummaryLine summary={reviews.summary} testId="public-review-summary" />
          ) : null}
        </header>

        <div className="isletme-page">
          <div className="isletme-reviews">
            {reviews ? (
              <ReviewsSection providerId={id} reviews={reviews} />
            ) : null}
          </div>

          <aside className="isletme-card" aria-label="İşletme kartı" data-testid="public-provider-card">
            <h2>Hakkında</h2>
            <p>{provider.description?.trim() || 'Bu işletme henüz bir tanıtım metni eklememiş.'}</p>

            <h2>Hizmetler</h2>
            <div className="pdash-chip-list">
              {provider.serviceCategories.length === 0 ? (
                <span className="pdash-card-sub">Kategori belirtilmemiş.</span>
              ) : (
                provider.serviceCategories.map((item) => (
                  <span className="tag tag-accent" key={item.id}>
                    {item.category.name}
                  </span>
                ))
              )}
            </div>

            <h2>Hizmet bölgeleri</h2>
            <div className="pdash-chip-list">
              {provider.serviceAreas.length === 0 ? (
                <span className="pdash-card-sub">Bölge belirtilmemiş.</span>
              ) : (
                provider.serviceAreas.map((area) => (
                  <span className="tag tag-neutral" key={area.id}>
                    {serviceAreaLabel(area)}
                  </span>
                ))
              )}
            </div>

            <p className="muted">
              İletişim bilgileri yalnız bir teklif kabul edildiğinde, iki taraf arasında
              paylaşılır. Bir talep oluşturarak bu işletmeden teklif alabilirsiniz.
            </p>
            <Link className="btn btn-primary" href="/categories">
              Talep oluştur
            </Link>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ReviewsSection({ providerId, reviews }: { providerId: string; reviews: PublicReviewsPage }) {
  return (
    <section data-testid="public-reviews" aria-labelledby="public-reviews-title">
      <div className="cdash-section-head">
        <h2 className="cdash-section-title" id="public-reviews-title">
          <span>Değerlendirmeler</span>
          {reviews.summary ? (
            <span className="cdash-section-count">{reviews.summary.count}</span>
          ) : null}
        </h2>
      </div>

      {reviews.summary === null ? (
        <p className="muted" data-testid="public-reviews-empty">
          Bu işletme için en az {PROVIDER_REVIEW_PUBLIC_MIN_COUNT} değerlendirme toplandığında
          ortalama puan ve yorumlar burada görünür.
        </p>
      ) : reviews.items.length === 0 ? (
        <p className="muted" data-testid="public-reviews-no-comments">
          Değerlendirmeler puan olarak bırakıldı; henüz yorum yok.
        </p>
      ) : (
        <ul className="review-list">
          {reviews.items.map((item) => (
            <li className="review-row" key={item.id} data-testid="public-review-row">
              <div className="review-row-head">
                <ReviewStars value={item.rating} />
                <span className="tag tag-neutral">{item.categoryName}</span>
                <span className="review-row-meta">{monthLabel(item.month)}</span>
              </div>
              {/* A text child, never markup: the comment is the customer's own words. */}
              <p className="review-row-comment">{item.comment}</p>
            </li>
          ))}
        </ul>
      )}

      {reviews.nextCursor ? (
        <div className="inline-actions" style={{ marginTop: 16 }}>
          <Link
            className="btn btn-secondary"
            href={`/isletme/${providerId}?cursor=${encodeURIComponent(reviews.nextCursor)}`}
          >
            Daha fazla
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The business, or null for anything a visitor may not see. A 404 and a 403
 * from the API are both null here; so is any status other than APPROVED,
 * whatever the caller's own relation to the profile.
 */
async function loadPublicProvider(id: string): Promise<PublicProviderCard | null> {
  try {
    const provider = await apiFetch<ProviderProfile>(`/providers/${encodeURIComponent(id)}`);
    if (provider.status !== 'APPROVED') return null;
    return {
      id: provider.id,
      businessName: provider.businessName,
      city: provider.city,
      district: provider.district,
      description: provider.description,
      status: provider.status,
      serviceCategories: provider.serviceCategories,
      serviceAreas: provider.serviceAreas,
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 400)) {
      return null;
    }
    throw error;
  }
}

/**
 * The public review list, or null when there is none to show: the API
 * answers 404 with the switch off (and for an unlistable provider, which the
 * profile above has already refused). Null hides the section entirely.
 */
async function loadPublicReviews(id: string, cursor: string | null): Promise<PublicReviewsPage | null> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  try {
    return await apiFetch<PublicReviewsPage>(
      `/providers/${encodeURIComponent(id)}/reviews/public?${query.toString()}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
