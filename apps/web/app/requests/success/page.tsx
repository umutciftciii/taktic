import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  apiFetch,
  type CustomerServiceRequest,
  fetchOrNotFound,
  getCurrentUser,
} from '../../../lib/api';
import { GuestActivationNote } from './activation-note';

type RequestSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

/**
 * A Prisma cuid: 25 characters, `c` first, base-36 after. Anything else in the
 * `id` slot is a hand-edited or truncated link, and is a 404 before any call.
 */
const REQUEST_ID_PATTERN = /^c[a-z0-9]{24}$/;

/** `#4F2A1C` — the tail of the id, for a screen that has no session to ask for the real number. */
function referenceFromId(id: string) {
  return `#${id.slice(-6).toUpperCase()}`;
}

/**
 * The screen after a request is sent.
 *
 * ## Where the words come from
 *
 * From the request itself, never from the URL. The old version let the form
 * report `published=1` and trusted it; this one carries only the id and asks
 * the API what state the request is really in, so the page can never promise
 * providers that a request waiting for an operator does not have, nor a review
 * that a request born live will never get.
 *
 * ## Three readers
 *
 * - **The owning customer**, signed in: `GET /service-requests/my/:id`. The
 *   endpoint answers 404 for a request that is not theirs exactly as it does
 *   for one that does not exist, and this page turns both into the same
 *   not-found screen — an id alone discloses nothing about anybody's request.
 *   A vitrin lead is worded as addressed to one business; `APPROVED` as live;
 *   everything else as waiting for review.
 * - **A visitor** with no session — a guest who just sent the form. There is
 *   no authorised call to make, so nothing is claimed: a neutral receipt with
 *   a reference derived from the id, and the way to the account the platform
 *   opened for them. No status, no business, no offer count.
 * - **Anybody else** — a provider, an operator — has no request of their own
 *   to see here and gets the not-found screen.
 */
export default async function RequestSuccessPage({ searchParams }: RequestSuccessPageProps) {
  const { id } = await searchParams;
  if (!id || !REQUEST_ID_PATTERN.test(id)) {
    notFound();
  }

  const user = await getCurrentUser();

  if (!user) {
    return <GuestReceipt id={id} />;
  }

  if (user.role !== 'CUSTOMER') {
    notFound();
  }

  const request = await fetchOrNotFound(() =>
    apiFetch<CustomerServiceRequest>(`/service-requests/my/${encodeURIComponent(id)}`),
  );

  return <CustomerReceipt request={request} />;
}

function GuestReceipt({ id }: { id: string }) {
  return (
    <main>
      <div className="page-narrow">
        <section data-testid="request-success" data-variant="guest">
          <span className="kicker">Talep alındı</span>
          <h1 className="page-title" data-testid="request-success-title">
            Talebiniz alındı
          </h1>
          <p className="page-subtitle">
            Talebiniz işleme alındı. Gelişmeleri hesabınızı etkinleştirdikten sonra takip
            edebilirsiniz.
          </p>
          <p style={{ marginTop: 14 }}>
            Talep referansı: <code data-testid="request-success-reference">{referenceFromId(id)}</code>
          </p>
          <GuestActivationNote />
          <div className="inline-actions" style={{ marginTop: 24 }}>
            <Link className="btn btn-primary" href="/">
              Ana sayfaya dön
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

function CustomerReceipt({ request }: { request: CustomerServiceRequest }) {
  const reference = request.requestNumber ?? referenceFromId(request.id);
  // A lead the customer has since released to the market is an ordinary
  // request again and is worded by its status below.
  const lead = request.showcaseLead && !request.showcaseLead.releasedAt ? request.showcaseLead : null;
  const variant = lead ? 'targeted' : request.status === 'APPROVED' ? 'published' : 'review';

  return (
    <main>
      <div className="page-narrow">
        <section data-testid="request-success" data-variant={variant}>
          {variant === 'targeted' && lead ? (
            <>
              <span className="kicker">Talep iletildi</span>
              <h1 className="page-title" data-testid="request-success-title">
                Talebiniz {lead.provider.businessName} işletmesine iletildi
              </h1>
              <p className="page-subtitle">
                Talebiniz yalnız seçtiğiniz işletmeye gönderildi; genel pazara açılmadı ve başka
                hizmet verenler görmez. İşletme size {lead.slaHours} saat içinde dönüş yapmayı
                taahhüt etti.
              </p>
            </>
          ) : variant === 'published' ? (
            <>
              <span className="kicker">Talep yayınlandı</span>
              <h1 className="page-title" data-testid="request-success-title">
                Talebiniz yayınlandı
              </h1>
              <p className="page-subtitle">
                Bölgenizdeki uygun hizmet verenler talebinizi şimdi görebilir ve teklif verebilir.
                Talebiniz 14 gün boyunca teklif alır.
              </p>
            </>
          ) : (
            <>
              <span className="kicker">Talep alındı</span>
              <h1 className="page-title" data-testid="request-success-title">
                Talebiniz ön incelemeye gönderildi
              </h1>
              <p className="page-subtitle">
                Onay sonrasında uygun hizmet verenler teklif gönderebilir. Talebiniz 14 gün boyunca
                teklif alır.
              </p>
            </>
          )}
          <p style={{ marginTop: 14 }}>
            Talep referansı: <code data-testid="request-success-reference">{reference}</code>
          </p>
          <div className="inline-actions" style={{ marginTop: 24 }}>
            <Link className="btn btn-primary" href={`/requests/${request.id}/offers`}>
              Teklifleri görüntüle
            </Link>
            <Link className="btn btn-secondary" href="/requests/my">
              Taleplerim
            </Link>
            <Link className="btn btn-secondary" href="/categories">
              Kategorilere dön
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
