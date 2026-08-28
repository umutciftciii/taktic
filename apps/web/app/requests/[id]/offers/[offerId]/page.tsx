import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  getContactDisclosure,
  RequestOfferDetail,
  formatDate,
  formatDateTime,
  formatPrice,
  getCurrentUser,
  statusLabel,
  type ContactDisclosureConfig,
} from '../../../../../lib/api';
import { CustomerShell } from '../../../customer-shell';
import { IconArrowLeft } from '../../../../landing-icons';
import { customerOfferAction } from './actions';

type RequestOfferDetailPageProps = {
  params: Promise<{ id: string; offerId: string }>;
  searchParams: Promise<{ accept?: string; message?: string }>;
};

export default async function RequestOfferDetailPage({
  params,
  searchParams,
}: RequestOfferDetailPageProps) {
  const { id, offerId } = await params;
  const { accept: acceptOutcome, message: acceptMessage } = await searchParams;

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/offers/${offerId}`);
  }

  // Unknown offer, offer on another request, another customer's request: all
  // one 404, never the error boundary.
  const offer = await fetchOrNotFound(() =>
    apiFetch<RequestOfferDetail>(`/service-requests/${id}/offers/${offerId}/view`, {
      method: 'POST',
    }),
  );

  const actionable =
    offer.status !== 'ACCEPTED' && offer.status !== 'REJECTED' && offer.status !== 'WITHDRAWN';

  // Read from the API so the screen and the rule that guards the accept agree
  // about which text is current. With sharing off there is nothing to confirm
  // and the acknowledgement is not rendered at all.
  const disclosure = await getContactDisclosure();

  return (
    <CustomerShell user={user} active="requests">
      <Link className="cdash-page-back" href={`/requests/${id}/offers`}>
        <IconArrowLeft size={14} />
        <span>Tekliflere dön</span>
      </Link>

      <header className="cdash-page-head">
        <span className="kicker">Teklif detayı</span>
        <h1 className="cdash-page-title">{offer.provider.businessName}</h1>
        <p className="cdash-page-sub">
          {offer.provider.city}
          {offer.provider.district ? `, ${offer.provider.district}` : ''}
        </p>
      </header>

      <div className="cdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="cdash-detail-card">
            <h2>Teklif</h2>
            <dl className="cdash-meta-list">
              <dt>Fiyat</dt>
              <dd>
                <strong>{formatPrice(offer.priceAmount, offer.currency)}</strong>
              </dd>
              <dt>Durum</dt>
              <dd>
                <span className={offerStatusClass(offer.status)} data-testid="offer-status">
                  {statusLabel(offer.status)}
                </span>
              </dd>
              <dt>Tahmini başlangıç</dt>
              <dd>{offer.estimatedStartDate ? formatDate(offer.estimatedStartDate) : '-'}</dd>
              <dt>Tahmini bitiş</dt>
              <dd>{offer.estimatedCompletionDate ? formatDate(offer.estimatedCompletionDate) : '-'}</dd>
              <dt>Gönderim</dt>
              <dd>{formatDateTime(offer.submittedAt)}</dd>
              <dt>Görüntülenme</dt>
              <dd>{offer.viewedAt ? formatDateTime(offer.viewedAt) : '-'}</dd>
            </dl>
          </section>

          <section className="cdash-detail-card">
            <h2>Mesaj</h2>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 14 }}>
              {offer.message}
            </p>
            {offer.warrantyNote ? (
              <>
                <h2 style={{ marginTop: 6, fontSize: 14 }}>Garanti notu</h2>
                <p
                  style={{
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  {offer.warrantyNote}
                </p>
              </>
            ) : null}
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="cdash-detail-card">
            <h2>Hizmet Veren</h2>
            <dl className="cdash-meta-list">
              <dt>İşletme</dt>
              <dd>{offer.provider.businessName}</dd>
              <dt>Konum</dt>
              <dd>
                {offer.provider.city}
                {offer.provider.district ? `, ${offer.provider.district}` : ''}
              </dd>
            </dl>
          </section>

          {/*
            Only the two actions that decide something. Shortlisting was removed:
            it moved the offer into a state with no product rule behind it —
            nothing filtered on it, nobody was notified, and the customer could
            not undo it — so the button promised a decision the platform never
            made. Accepting and rejecting are unchanged, and so is every state
            that makes them unavailable.
          */}
          {actionable ? (
            <section className="cdash-detail-card">
              <h2>Aksiyonlar</h2>
              {acceptOutcome === 'error' ? (
                <div
                  className="cdash-notice cdash-notice-error"
                  role="alert"
                  data-testid="offer-accept-error"
                  style={{ marginBottom: 12 }}
                >
                  {acceptMessage || 'Teklif kabul edilemedi. Lütfen tekrar deneyin.'}
                </div>
              ) : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="offer-actions">
                <AcceptForm requestId={id} offerId={offerId} disclosure={disclosure} />
                <ActionButton
                  requestId={id}
                  offerId={offerId}
                  action="REJECT"
                  label="Reddet"
                  variant="danger"
                />
              </div>
            </section>
          ) : null}

          {/*
            Only on the offer that was actually accepted. Messaging follows the
            match, so putting this on a pending or rejected offer would promise
            a conversation that cannot be opened.
          */}
          {offer.status === 'ACCEPTED' ? (
            <section className="cdash-detail-card">
              <h2>Mesajlaşma</h2>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
                Bu iş için hizmet verenle uygulama içinden yazışabilirsiniz.
              </p>
              <Link
                className="cdash-btn cdash-btn-primary cdash-btn-block"
                href={`/mesajlar/talep/${id}`}
                data-testid="offer-message-cta"
              >
                Mesaj gönder
              </Link>
            </section>
          ) : null}

          <div className="cdash-notice">
            {disclosure.enabled
              ? 'Teklifi kabul ettiğinizde eşleşme tamamlanır ve iletişim bilgileriniz yalnızca kabul ettiğiniz hizmet verenle karşılıklı olarak paylaşılır.'
              : 'Teklifi kabul ettiğinizde hizmet veren bilgilendirilir.'}
          </div>
        </div>
      </div>
    </CustomerShell>
  );
}

/**
 * The accept control, and the acknowledgement it is not allowed to skip.
 *
 * The checkbox is `required`, so the browser refuses the submit without it, and
 * the confirmation travels in the same request as the action. That is a
 * convenience and not the rule: the API re-checks it inside the accept
 * transaction and refuses a match that carries no current-version consent, so a
 * client that posts around this form gets the same answer.
 *
 * The version the screen actually rendered goes along too. If the wording has
 * been replaced since this page was served the API says so rather than filing
 * the answer against a text the customer never saw.
 */
function AcceptForm({
  requestId,
  offerId,
  disclosure,
}: {
  requestId: string;
  offerId: string;
  disclosure: ContactDisclosureConfig;
}) {
  const checkboxId = `contact-disclosure-${offerId}`;

  return (
    <form action={customerOfferAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="action" value="ACCEPT" />
      {disclosure.enabled ? (
        <>
          <input
            type="hidden"
            name="contactDisclosureVersion"
            value={disclosure.disclosureVersion ?? ''}
          />
          <label
            className="cdash-consent"
            htmlFor={checkboxId}
            data-testid="contact-disclosure-consent"
          >
            <input
              id={checkboxId}
              type="checkbox"
              name="contactDisclosureAccepted"
              value="true"
              required
            />
            <span>
              Teklifi kabul ettiğimde ad, telefon ve e-posta bilgilerimin yalnızca bu hizmet verenle
              paylaşılacağını{' '}
              {disclosure.disclosureUrl ? (
                <a href={disclosure.disclosureUrl} target="_blank" rel="noreferrer">
                  aydınlatma metninde
                </a>
              ) : (
                'aydınlatma metninde'
              )}{' '}
              okudum ve onaylıyorum.
            </span>
          </label>
        </>
      ) : null}
      <button className="cdash-btn cdash-btn-primary cdash-btn-block" type="submit">
        Kabul Et
      </button>
    </form>
  );
}

function ActionButton({
  requestId,
  offerId,
  action,
  label,
  variant,
}: {
  requestId: string;
  offerId: string;
  action: 'REJECT';
  label: string;
  variant: 'primary' | 'danger';
}) {
  const className =
    variant === 'primary'
      ? 'cdash-btn cdash-btn-primary cdash-btn-block'
      : 'cdash-btn cdash-btn-danger cdash-btn-block';

  return (
    <form action={customerOfferAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="action" value={action} />
      <button className={className} type="submit">
        {label}
      </button>
    </form>
  );
}

function offerStatusClass(status: string): string {
  switch (status) {
    case 'ACCEPTED':
      return 'tag tag-ink';
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'tag tag-neutral';
    case 'SHORTLISTED':
      return 'tag tag-accent';
    case 'SUBMITTED':
    case 'VIEWED':
    default:
      return 'tag tag-neutral';
  }
}
