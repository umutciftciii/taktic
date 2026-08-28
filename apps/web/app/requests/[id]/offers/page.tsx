import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerServiceRequest,
  MatchedProviderContact,
  fetchOrNotFound,
  loadMatchedContact,
  MATCHED_CONTACT_UNAVAILABLE_MESSAGES,
  RequestOfferPreview,
  formatDateTime,
  getCurrentUser,
  statusLabel,
} from '../../../../lib/api';
import { CustomerShell } from '../../customer-shell';
import { IconArrowLeft, IconCheck, IconMail, IconPhone } from '../../../landing-icons';
import { statusPillClass } from '../../../status-pill';
import { completeRequestAction, sendPhoneCodeAction, verifyPhoneCodeAction } from './actions';
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
          <p className="cdash-summary-body">{summaryBody(summary)}</p>

          {summary && !summary.phoneVerifiedAt ? (
            <PhoneVerificationCard
              requestId={id}
              customerPhone={summary.customerPhone}
              state={verificationState}
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
            <ol className="pdash-timeline" style={{ marginTop: 12 }}>
              <TimelineStep title="Talep alındı" done meta={summary ? formatDateTime(summary.submittedAt) : null} />
              <TimelineStep
                title="Ön inceleme"
                done={Boolean(summary && summary.status !== 'SUBMITTED' && summary.status !== 'IN_REVIEW')}
              />
              <TimelineStep
                title="Teklif toplama"
                done={Boolean(summary && summary.offersCount > 0)}
                meta={summary ? `${summary.offersCount} teklif` : null}
              />
              <TimelineStep
                title="Eşleşme"
                done={summary?.status === 'MATCHED' || summary?.status === 'COMPLETED'}
              />
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

      <OffersView requestId={id} offers={sortedOffers} />

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
          */}
          <ul className="cdash-history" data-testid="withdrawn-offers">
            {withdrawnOffers.map((offer) => (
              <li className="cdash-history-item" key={offer.id}>
                <span className="tag tag-neutral">Teklif geri çekildi</span>
                <span className="cdash-history-name">{offer.provider.businessName}</span>
                <span className="cdash-history-time">{formatDateTime(offer.submittedAt)}</span>
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
 * Optional today: while REQUIRE_PHONE_VERIFICATION is off, verifying changes
 * nothing about how the request is handled, so this card informs and invites
 * but never blocks. It also makes no claim that the request *is* verified.
 */
function PhoneVerificationCard({
  requestId,
  customerPhone,
  state,
}: {
  requestId: string;
  customerPhone: string;
  state: string | null;
}) {
  return (
    <div className="cdash-verify-card" style={{ marginTop: 24 }}>
      <span className="cdash-summary-label">Telefon Doğrulama</span>
      <p className="cdash-summary-body">
        {maskPhoneForDisplay(customerPhone)} numarasını doğrulayarak talebinizin bize doğru
        ulaştığını teyit edebilirsiniz. Doğrulama şu anda zorunlu değildir ve talebiniz normal
        şekilde ilerler.
      </p>

      {state ? <p className="cdash-summary-body">{verificationMessage(state)}</p> : null}

      <div className="verify-row">
        <form action={sendPhoneCodeAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <button className="cdash-btn cdash-btn-secondary" type="submit">
            Doğrulama kodu gönder
          </button>
        </form>

        <form action={verifyPhoneCodeAction} className="verify-row">
          <input type="hidden" name="requestId" value={requestId} />
          <label className="cdash-visually-hidden" htmlFor="phone-code">
            Doğrulama kodu
          </label>
          <input
            id="phone-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            placeholder="6 haneli kod"
            style={{ maxWidth: 160 }}
            required
          />
          <button className="cdash-btn cdash-btn-primary" type="submit">
            Doğrula
          </button>
        </form>
      </div>
    </div>
  );
}

function verificationMessage(state: string): string {
  switch (state) {
    case 'ok':
      return 'İşlem tamamlandı. Kod gönderildiyse birkaç dakika içinde ulaşır.';
    case 'invalid':
      return 'Kod geçersiz veya süresi dolmuş. Yeni bir kod isteyebilirsiniz.';
    case 'rate-limited':
      return 'Çok fazla kod istendi. Lütfen bir süre sonra tekrar deneyin.';
    case 'already-verified':
      return 'Bu talebin telefonu zaten doğrulanmış.';
    default:
      return 'İşlem şu anda tamamlanamadı. Lütfen daha sonra tekrar deneyin.';
  }
}

/** Display-only mask; the server never sends the full number back either. */
function maskPhoneForDisplay(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return '***';
  }
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 5, 0))}${digits.slice(-2)}`;
}

function summaryBody(summary: CustomerServiceRequest | null) {
  if (!summary) {
    return 'Bu talebe ait özet bilgileri görüntülenemiyor. Talebiniz başka bir hesaptan oluşturulmuş olabilir.';
  }

  if (summary.status === 'MATCHED') {
    return 'Bir teklifi kabul ettiniz. Talebiniz artık yeni teklif almıyor. Hizmet tamamlandığında aşağıdan işaretleyebilirsiniz.';
  }

  if (summary.status === 'COMPLETED') {
    return 'Bu talep tamamlandı olarak işaretlendi.';
  }

  // Neutral and factual: the window closed, and that is all it means.
  if (summary.status === 'EXPIRED') {
    return summary.expiredAt
      ? `Talebin geçerlilik süresi ${formatDateTime(summary.expiredAt)} tarihinde doldu. Talep artık yeni teklif almıyor; daha önce gelen teklifleri aşağıda görebilirsiniz.`
      : 'Talebin geçerlilik süresi doldu. Talep artık yeni teklif almıyor; daha önce gelen teklifleri aşağıda görebilirsiniz.';
  }

  return 'Talebiniz hizmet verenlere iletildi. Aşağıdaki kartlarda gelen teklifleri inceleyebilirsiniz.';
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

async function safeFetchMyRequests(): Promise<CustomerServiceRequest[]> {
  try {
    return await apiFetch<CustomerServiceRequest[]>('/service-requests/my');
  } catch {
    return [];
  }
}
