import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  CustomerServiceRequest,
  fetchOrNotFound,
  formatDateTime,
  getCurrentUser,
  SHOWCASE_LEAD_STATUS_LABELS,
  SHOWCASE_LEAD_URGENCY_LABELS,
  type ShowcaseCustomerLead,
} from '../../../../lib/api';
import { CustomerShell } from '../../customer-shell';
import { IconArrowLeft } from '../../../landing-icons';
import { decideShowcaseFallbackAction } from './actions';

type FallbackPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ error?: string; decided?: string }>;
};

const FALLBACK_ERRORS: Record<string, string> = {
  SHOWCASE_FALLBACK_NOT_AVAILABLE: 'Bu talep için şu anda verilecek bir karar yok.',
  SHOWCASE_FALLBACK_ALREADY_DECIDED: 'Bu talep için kararınız zaten kaydedildi.',
  SHOWCASE_LEAD_NOT_FOUND: 'Talep bulunamadı.',
  SHOWCASE_FALLBACK_FAILED: 'Kararınız kaydedilemedi. Lütfen tekrar deneyin.',
};

/**
 * The one decision only the customer can make.
 *
 * ## What this page is careful about
 *
 * A missed deadline opens nothing. The request is still reserved for the one
 * business the customer wrote to, and it stays that way unless they say
 * otherwise — the database refuses a release that is not accompanied by their
 * decision. So the page presents two genuine options rather than a call to
 * action with an escape hatch: "open it to others" and "keep it closed" are
 * given the same weight, because pushing towards the first would be the
 * platform deciding on somebody's behalf which businesses get their details.
 *
 * It also says plainly what happens after a release — the request is reviewed
 * before it reaches anybody else — because that review is the thing that makes
 * releasing safe, and a customer worrying about who sees their request deserves
 * to know it is there.
 *
 * ## Why silence is not a third button
 *
 * Doing nothing is already an answer, and the product treats it as one: after
 * fourteen days the request closes. Saying so here is what makes that fair,
 * rather than something the customer finds out afterwards.
 */
export default async function ShowcaseFallbackPage({ params, searchParams }: FallbackPageProps) {
  const { id } = await params;
  const { error, decided } = (await searchParams) ?? {};

  const user = await getCurrentUser();
  if (!user || user.role !== 'CUSTOMER') {
    redirect(`/login?redirectTo=/requests/${id}/vitrin-karar`);
  }

  // The customer's own request list rather than a lead endpoint: a customer has
  // no vitrin vocabulary and no lead id, and the thing they are deciding about
  // is their request.
  const requests = await fetchOrNotFound(() =>
    apiFetch<CustomerServiceRequest[]>('/service-requests/my'),
  );
  const request = requests.find((item) => item.id === id) ?? null;

  if (!request) {
    redirect('/requests/my');
  }

  const lead = request.showcaseLead ?? null;

  return (
    <CustomerShell user={user} active="offers">
      <Link className="cdash-page-back" href="/requests/my">
        <IconArrowLeft size={14} />
        <span>Taleplerime dön</span>
      </Link>

      <section className="cdash-summary">
        <div className="cdash-summary-main">
          <h1 className="cdash-page-title">Talebiniz için kararınız</h1>
          <p className="muted">
            {request.requestNumber ?? 'Talebiniz'} · {request.category?.name ?? ''}
          </p>
        </div>
      </section>

      {error ? (
        <div className="notice cdash-notice-error" role="alert">
          {FALLBACK_ERRORS[error] ?? FALLBACK_ERRORS.SHOWCASE_FALLBACK_FAILED}
        </div>
      ) : null}

      {decided === 'release' ? (
        <div className="notice" role="status" data-testid="showcase-fallback-released">
          Talebiniz genel pazara açılıyor. Ekibimiz talebi inceledikten sonra bölgenizdeki
          hizmet verenlere iletilecek ve teklifler gelmeye başlayacak.
        </div>
      ) : null}
      {decided === 'closed' ? (
        <div className="notice" role="status" data-testid="showcase-fallback-closed">
          Talebiniz kapatıldı ve başka hiçbir hizmet verene iletilmedi. İstediğiniz zaman yeni
          bir talep oluşturabilirsiniz.
        </div>
      ) : null}

      {!lead ? (
        <div className="cdash-card">
          <p className="muted">Bu talep bir vitrin kartından açılmadı.</p>
        </div>
      ) : lead.status !== 'BREACHED' ? (
        <div className="cdash-card">
          <p className="muted">
            Bu talep için şu anda verilecek bir karar yok. Durum:{' '}
            {SHOWCASE_LEAD_STATUS_LABELS[lead.status]}.
          </p>
          <Link className="pdash-btn pdash-btn-secondary" href={`/requests/${id}/offers`}>
            Talebimi görüntüle
          </Link>
        </div>
      ) : (
        <>
          <section className="cdash-card">
            <h2>Ne oldu?</h2>
            <p>
              <strong>{lead.provider.businessName}</strong>, talebinize kartında taahhüt ettiği
              süre içinde dönmedi.
            </p>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Seçtiğiniz aciliyet</dt>
                <dd>
                  {SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]} · {lead.slaHours} saat
                </dd>
              </div>
              <div className="pdash-info-row">
                <dt>Süre bitişi</dt>
                <dd>{formatDateTime(lead.slaDueAt)}</dd>
              </div>
            </dl>
            <p className="muted">
              Talebiniz şu anda yalnız bu işletmeye açık. Siz karar vermedikçe başka hiçbir
              hizmet verene gönderilmez.
            </p>
          </section>

          <div className="cdash-card">
            <h2>Talebimi diğer hizmet verenlere aç</h2>
            <p>
              Talebiniz önce ekibimiz tarafından incelenir, sonra bölgenizdeki uygun hizmet
              verenlere iletilir ve birden fazla teklif alabilirsiniz.
            </p>
            <form action={decideShowcaseFallbackAction}>
              <input type="hidden" name="requestId" value={id} />
              <input type="hidden" name="decision" value="RELEASE" />
              <button
                className="pdash-btn pdash-btn-primary"
                type="submit"
                data-testid="showcase-fallback-release"
              >
                Diğer hizmet verenlere aç
              </button>
            </form>
          </div>

          <div className="cdash-card">
            <h2>Talebimi kapat</h2>
            <p>
              Talebiniz kapanır ve hiçbir hizmet verene iletilmez. Dilediğiniz zaman yeni bir
              talep oluşturabilirsiniz.
            </p>
            <form action={decideShowcaseFallbackAction}>
              <input type="hidden" name="requestId" value={id} />
              <input type="hidden" name="decision" value="KEEP_CLOSED" />
              <button
                className="pdash-btn pdash-btn-secondary"
                type="submit"
                data-testid="showcase-fallback-keep-closed"
              >
                Talebimi kapat
              </button>
            </form>
          </div>

          <p className="muted" style={{ fontSize: 13 }}>
            Karar vermezseniz talebiniz 14 gün sonra kendiliğinden kapanır ve hiçbir hizmet
            verene iletilmez.
          </p>
        </>
      )}
    </CustomerShell>
  );
}
