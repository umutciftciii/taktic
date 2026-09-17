import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  type CustomerReviewState,
  CustomerServiceRequest,
  MatchedProviderContact,
  fetchOrNotFound,
  loadMatchedContact,
  MATCHED_CONTACT_UNAVAILABLE_MESSAGES,
  RequestOfferPreview,
  formatDateTime,
  getCurrentUser,
  getMarketplacePublishPolicy,
  statusLabel,
} from '../../../../lib/api';
import {
  maskPhoneForDisplay,
  noOffersYetText,
  requestSummaryBody,
  requestTimelineSteps,
} from '../../../../lib/request-lifecycle';
import { CustomerShell } from '../../customer-shell';
import { IconArrowLeft, IconCheck, IconMail, IconPhone } from '../../../landing-icons';
import { ReviewStars } from '../../../review-stars';
import { statusPillClass } from '../../../status-pill';
import { completeRequestAction } from './actions';
import { PhoneVerificationCard } from './phone-verification-card';
import { readTurnstileWebConfig } from '../../../../lib/turnstile';
import { OffersView } from './offers-view';

type RequestOffersPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RequestOffersPage({ params, searchParams }: RequestOffersPageProps) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const verificationState = typeof query.verification === 'string' ? query.verification : null;

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/offers`);
  }

  // An unknown request and somebody else's request are the same 404 here: the
  // API answers 403 for a request that belongs to another customer, and telling
  // this one that it exists would be a disclosure on its own.
  const [offers, myRequests, matchedContact] = await Promise.all([
    fetchOrNotFound(() => apiFetch<RequestOfferPreview[]>(`/service-requests/${id}/offers`)),
    safeFetchMyRequests(),
    // Its own request, never part of the offer payload. The result says which
    // kind of "no" came back, because a customer looking at their own matched
    // request is entitled to know why the details are missing.
    loadMatchedContact<MatchedProviderContact>(`/service-requests/${id}/matched-contact`),
  ]);

  const summary = myRequests.find((request) => request.id === id) ?? null;
  // Only a request waiting for the customer's own proof needs to say what
  // that proof leads to — publish or review — and that is the switch's word,
  // read fail-closed exactly as the request form reads it. Display only: the
  // API decides what verifying does in its own flow.
  const awaitingVerification = summary?.awaitingPhoneVerification === true;
  const autoPublishEnabled = awaitingVerification ? await getMarketplacePublishPolicy() : false;
  // The customer's review state for this request. Read for every status, not
  // only COMPLETED, because it also answers whether reviews are on at all:
  // `disabled` is what the API says while the switch is off, and that is the
  // one signal this page has for hiding every rating on the offer cards. A
  // failure hides them too — the safe side of a missing line.
  const reviewState = await safeFetchReviewState(id);
  const reviewsEnabled = reviewState !== null && reviewState.eligibility !== 'disabled';
  // A withdrawn offer is not a choice the customer has, so it is kept out of the
  // comparison list and its count entirely. It stays visible further down, as a
  // neutral history line, because the customer did once receive it.
  const withdrawnOffers = offers.filter((offer) => offer.status === 'WITHDRAWN');
  const sortedOffers = offers
    .filter((offer) => offer.status !== 'WITHDRAWN')
    .sort((a, b) => a.priceAmount - b.priceAmount);
  const requestReference = summary?.requestNumber ?? `#${id.slice(-6).toUpperCase()}`;
  // Whether this customer has a match at all decides whether an unavailable
  // contact card is worth explaining or simply is not their business.
  const isMatched = summary?.status === 'MATCHED' || summary?.status === 'COMPLETED';

  return (
    <CustomerShell user={user} active="offers">
      <Link className="cdash-page-back" href="/requests/my">
        <IconArrowLeft size={14} />
        <span>Taleplerime dön</span>
      </Link>

      <section className="cdash-summary">
        <div className="cdash-summary-main">
          <div className="cdash-summary-head">
            <span className={statusPillClass(summary?.status ?? 'SUBMITTED')} data-testid="request-status">
              {statusLabel(summary?.status ?? 'SUBMITTED')}
            </span>
            <span className="cdash-offer-sub">{requestReference}</span>
          </div>

          <h2 className="cdash-summary-title">{summary?.category?.name ?? 'Talep detayı'}</h2>

          <div className="cdash-summary-meta">
            <span>
              {summary ? (
                <>
                  {summary.city}
                  {summary.district ? `, ${summary.district}` : ''}
                </>
              ) : (
                '—'
              )}
            </span>
            <span>{summary ? formatDateTime(summary.submittedAt) : '—'}</span>
          </div>

          <hr className="cdash-summary-divider" />

          <span className="cdash-summary-label">Talep özeti</span>
          <p className="cdash-summary-body" data-testid="request-summary-body">
            {requestSummaryBody(summary, autoPublishEnabled)}
          </p>

          {summary && !summary.phoneVerifiedAt ? (
            <PhoneVerificationCard
              requestId={id}
              maskedPhone={maskPhoneForDisplay(summary.customerPhone)}
              required={awaitingVerification}
              autoPublishEnabled={autoPublishEnabled}
              state={verificationState}
              turnstile={readTurnstileWebConfig()}
            />
          ) : null}

          {summary?.status === 'MATCHED' ? (
            <form action={completeRequestAction} style={{ marginTop: 16 }}>
              <input type="hidden" name="requestId" value={id} />
              <button className="cdash-btn cdash-btn-primary" type="submit">
                Hizmet tamamlandı
              </button>
            </form>
          ) : null}

          {/*
            The review call to action, only once the job is done and only while
            reviews are on. The API's customer state is what says both: it is
            `disabled` with the switch off, and the link is simply absent then —
            the completed request looks exactly as it did before the feature.
          */}
          {summary?.status === 'COMPLETED' && reviewState && reviewState.eligibility !== 'disabled' ? (
            <div className="cdash-review-cta" data-testid="request-review-cta" style={{ marginTop: 16 }}>
              {reviewState.review ? (
                <>
                  <ReviewStars value={reviewState.review.rating} />
                  <Link className="cdash-btn cdash-btn-secondary" href={`/requests/${id}/degerlendir`}>
                    Değerlendirmenizi görün
                  </Link>
                </>
              ) : reviewState.eligibility === 'ok' ? (
                <Link className="cdash-btn cdash-btn-primary" href={`/requests/${id}/degerlendir`}>
                  Hizmet vereni değerlendir
                </Link>
              ) : (
                <span className="cdash-offer-sub">Değerlendirme süresi doldu.</span>
              )}
            </div>
          ) : null}
        </div>

        <aside className="cdash-summary-rail" aria-label="Talep durumu">
          <span className="cdash-summary-label">Kalite skoru</span>
          <div className="quality-head">
            <span className="quality-score">
              {summary ? summary.qualityScore : '—'}
              <sup>/100</sup>
            </span>
          </div>
          {summary ? (
            <div className="databar" style={{ marginTop: 12 }}>
              <div className="databar-fill" style={{ width: `${summary.qualityScore}%` }} />
            </div>
          ) : null}

          <div style={{ marginTop: 24 }}>
            <span className="cdash-summary-label">Süreç</span>
            <ol className="pdash-timeline" style={{ marginTop: 12 }} data-testid="request-timeline">
              {requestTimelineSteps(summary, autoPublishEnabled).map((step) => (
                <TimelineStep key={step.title} title={step.title} done={step.done} meta={step.meta} />
              ))}
            </ol>
          </div>
        </aside>
      </section>

      {matchedContact.state === 'ready' ? (
        <MatchedContactSection contact={matchedContact.contact} />
      ) : isMatched && matchedContact.state === 'unavailable' ? (
        /*
          Matched, and the details did not load. This customer accepted an offer
          and was told the match was complete, so the section that should carry
          the provider's number must not just be absent. The sentence names the
          cause and nothing about the other party.
        */
        <section
          className="cdash-notice cdash-notice-error"
          role="status"
          data-testid="matched-contact-unavailable"
          style={{ marginTop: 24 }}
        >
          {MATCHED_CONTACT_UNAVAILABLE_MESSAGES[matchedContact.reason]}
        </section>
      ) : null}

      <OffersView
        requestId={id}
        offers={sortedOffers}
        reviewsEnabled={reviewsEnabled}
        emptyText={noOffersYetText(summary)}
      />

      {withdrawnOffers.length > 0 ? (
        <>
          <div className="cdash-section-head">
            <h2 className="cdash-section-title">
              <span>Geçmiş</span>
              <span className="cdash-section-count">{withdrawnOffers.length}</span>
            </h2>
          </div>
          {/*
            Name, date and the fact of the withdrawal — nothing else. The price
            is deliberately absent: it is not an amount the customer can take,
            and showing it next to the live offers would read as a comparison.

            One sentence more for an offer the customer had already opened: they
            read it as a live choice, so its disappearance is told to them as a
            cancellation rather than filed away. It is about the offer only —
            the provider's credit and refund are not the customer's business
            and are not mentioned.
          */}
          <ul className="cdash-history" data-testid="withdrawn-offers">
            {withdrawnOffers.map((offer) => (
              <li
                className="cdash-history-item"
                key={offer.id}
                data-testid="withdrawn-offer"
                data-viewed={offer.viewedAt ? 'true' : 'false'}
              >
                <span className="tag tag-neutral">Teklif geri çekildi</span>
                <span className="cdash-history-name">{offer.provider.businessName}</span>
                <span className="cdash-history-time">{formatDateTime(offer.submittedAt)}</span>
                {offer.viewedAt ? (
                  <span
                    className="cdash-history-notice"
                    role="status"
                    data-testid="offer-withdrawn-notice"
                  >
                    Bu teklif hizmet veren tarafından iptal edilmiştir.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </CustomerShell>
  );
}

function TimelineStep({
  title,
  done,
  meta,
}: {
  title: string;
  done: boolean;
  meta?: string | null;
}) {
  return (
    <li className={`pdash-timeline-item${done ? '' : ' is-idle'}`}>
      <div>
        <div className="pdash-timeline-title">{title}</div>
        {meta ? <div className="pdash-timeline-meta">{meta}</div> : null}
      </div>
    </li>
  );
}

/**
 * Shown only once the request is matched and the reveal is on record.
 *
 * Every value here came from the matched-contact route, which checks the match,
 * the audit row and the caller before it answers. Nothing on this page reads a
 * contact detail out of an offer, because no offer carries one.
 */
function MatchedContactSection({ contact }: { contact: MatchedProviderContact }) {
  const { provider } = contact;

  return (
    <>
      <section className="match-poster" style={{ marginTop: 32 }}>
        <span className="kicker">Eşleşme tamamlandı</span>
        <h2>Ustanla iletişime geçebilirsin.</h2>
        <p>
          Teklifini kabul ettiğin hizmet verenin iletişim bilgileri aşağıda. Paylaşım kayıt altına
          alındı.
        </p>
      </section>

      <section className="cdash-contact-card" data-testid="matched-contact" style={{ marginTop: 0 }}>
        <div className="cdash-contact-head">
          <h2 className="cdash-contact-title">İletişim bilgileri</h2>
          <span className="tag tag-ink">
            <IconCheck size={11} />
            Eşleşme tamamlandı
          </span>
        </div>

        <dl className="cdash-contact-list">
          <dt>İşletme</dt>
          <dd data-testid="matched-contact-name">{provider.businessName}</dd>
          <dt>Yetkili</dt>
          <dd>{provider.contactName}</dd>
          <dt>Telefon</dt>
          <dd>
            <a href={`tel:${provider.phone}`} data-testid="matched-contact-phone">
              {provider.phone}
            </a>
          </dd>
          <dt>E-posta</dt>
          <dd>{provider.email ? <a href={`mailto:${provider.email}`}>{provider.email}</a> : '-'}</dd>
          <dt>Konum</dt>
          <dd>
            {provider.city}
            {provider.district ? `, ${provider.district}` : ''}
          </dd>
          <dt>Paylaşım zamanı</dt>
          <dd>{formatDateTime(contact.revealedAt)}</dd>
        </dl>

        <div className="inline-actions">
          <a className="cdash-btn cdash-btn-primary" href={`tel:${provider.phone}`}>
            <IconPhone size={14} />
            Telefonla ara
          </a>
          {provider.email ? (
            <a className="cdash-btn cdash-btn-secondary" href={`mailto:${provider.email}`}>
              <IconMail size={14} />
              E-posta gönder
            </a>
          ) : null}
        </div>

        <p className="cdash-contact-note">
          Güvenli iletişim: bu bilgiler yalnızca eşleşen iki taraf arasında paylaşılır ve paylaşım
          kaydı tutulur.
        </p>
      </section>
    </>
  );
}

async function safeFetchReviewState(requestId: string): Promise<CustomerReviewState | null> {
  try {
    return await apiFetch<CustomerReviewState>(`/service-requests/${requestId}/review`);
  } catch {
    return null;
  }
}

async function safeFetchMyRequests(): Promise<CustomerServiceRequest[]> {
  try {
    return await apiFetch<CustomerServiceRequest[]>('/service-requests/my');
  } catch {
    return [];
  }
}
