import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, loadPackageRefundOptions } from '../../../lib/api';
import { IconArrowLeft } from '../../landing-icons';
import { PanelShell } from '../../panel-shell';
import { initialPackageRefundSelection } from '../../../lib/package-refund';
import { NewTicketForm } from '../new-ticket-form';

/**
 * Opening a ticket, from either panel.
 *
 * A screen of its own rather than a form folded into the list, because the two
 * answer different questions — "what have I asked" and "I want to ask
 * something" — and a list that turns into a form loses the reader's place every
 * time the form is refused.
 *
 * Nothing on the form says which desk the ticket is filed at, and nothing can:
 * the API takes that from the session alongside the owner, so the same two
 * fields open a hizmet alan's ticket and a hizmet veren's.
 */
type NewSupportTicketPageProps = {
  searchParams: Promise<{ type?: string | string[]; purchaseId?: string | string[] }>;
};

export default async function NewSupportTicketPage({ searchParams }: NewSupportTicketPageProps) {
  const query = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    // The purchase page's link survives sign-in: the query is only a
    // starting point, re-checked against the API's list after it.
    const back = new URLSearchParams();
    if (typeof query.type === 'string') back.set('type', query.type);
    if (typeof query.purchaseId === 'string') back.set('purchaseId', query.purchaseId);
    // Encoded only when there is a query to carry: its `&` would otherwise
    // end `redirectTo` early. The plain path keeps its long-standing form.
    const search = back.toString();
    redirect(
      search
        ? `/login?redirectTo=${encodeURIComponent(`/destek/yeni?${search}`)}`
        : '/login?redirectTo=/destek/yeni',
    );
  }
  if (user.role !== 'CUSTOMER' && user.role !== 'PROVIDER') {
    redirect('/');
  }

  // CMP-006 PR-B: only a provider can ask for a package refund, and only when
  // the API says the flow is open and something was bought under it. Anything
  // else — including a failed read — leaves the form exactly the general one.
  const refundOptions = user.role === 'PROVIDER' ? await loadPackageRefundOptions() : null;
  // PR-B.1: `?type=PACKAGE_REFUND&purchaseId=…` from the purchase page. The
  // query can only choose among what the API listed; a purchase that is not
  // on that list is dropped, never shown.
  const initial = initialPackageRefundSelection(query, refundOptions);

  return (
    <PanelShell user={user} active="support">
      <div className="cdash-support" data-testid="support-screen">
        <Link className="cdash-page-back" href="/destek">
          <IconArrowLeft size={14} />
          <span>Destek taleplerine dön</span>
        </Link>

        <header className="cdash-page-head">
          <span className="kicker">Destek</span>
          <h1 className="cdash-page-title">Yeni destek talebi</h1>
          <p className="cdash-page-sub">
            Konuyu kısaca özetleyin ve sorununuzu anlatın. Talebiniz yalnızca sizin ve destek
            ekibimizin görebileceği bir yazışma olarak açılır.
          </p>
        </header>

        <section className="cdash-detail-card" aria-labelledby="support-new-heading">
          <h2 id="support-new-heading">Talep bilgileri</h2>
          <NewTicketForm
            refundOptions={refundOptions?.available ? refundOptions : null}
            initialRefund={initial.refund}
            initialPurchaseId={initial.purchaseId}
          />
        </section>

        <div className="cdash-notice">
          Şifre, kart bilgisi veya doğrulama kodu gibi gizli bilgileri destek mesajlarına yazmayın.
          Destek ekibi bunları hiçbir zaman istemez.
        </div>
      </div>
    </PanelShell>
  );
}
