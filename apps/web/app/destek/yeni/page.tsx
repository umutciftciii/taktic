import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/api';
import { IconArrowLeft } from '../../landing-icons';
import { CustomerShell } from '../../requests/customer-shell';
import { NewTicketForm } from '../new-ticket-form';

/**
 * Opening a ticket.
 *
 * A screen of its own rather than a form folded into the list, because the two
 * answer different questions — "what have I asked" and "I want to ask
 * something" — and a list that turns into a form loses the reader's place every
 * time the form is refused.
 */
export default async function NewSupportTicketPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/destek/yeni');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  return (
    <CustomerShell user={user} active="support">
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
          <NewTicketForm />
        </section>

        <div className="cdash-notice">
          Şifre, kart bilgisi veya doğrulama kodu gibi gizli bilgileri destek mesajlarına yazmayın.
          Destek ekibi bunları hiçbir zaman istemez.
        </div>
      </div>
    </CustomerShell>
  );
}
