import Link from 'next/link';
import { apiFetch, Offer, OfferStatus } from '../../../lib/api';
import { refundOfferCreditAction, updateOfferStatusAction } from '../actions';

const statuses: OfferStatus[] = [
  'SUBMITTED',
  'VIEWED',
  'SHORTLISTED',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
];

type OfferDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OfferDetailPage({ params }: OfferDetailPageProps) {
  const { id } = await params;
  const offer = await apiFetch<Offer>(`/offers/${id}`);

  return (
    <main>
      <p>
        <Link href="/offers">Back to offers</Link>
      </p>
      <h1>Offer Detail</h1>
      <section>
        <h2>Summary</h2>
        <p>ID: {offer.id}</p>
        <p>Status: {offer.status}</p>
        <p>
          Price: {offer.priceAmount} {offer.currency}
        </p>
        <p>Message: {offer.message}</p>
        <p>Warranty: {offer.warrantyNote ?? '-'}</p>
        <p>Internal note: {offer.internalNote ?? '-'}</p>
        <p>Credit cost: {offer.creditCost}</p>
        <p>Credit spend transaction: {offer.creditSpentTransactionId ?? '-'}</p>
        <p>Credit refund transaction: {offer.creditRefundedTransactionId ?? '-'}</p>
        <p>Credit refunded: {offer.creditRefundedAt ? formatDate(offer.creditRefundedAt) : '-'}</p>
        <p>Credit refund reason: {offer.creditRefundReason ?? '-'}</p>
        <p>Submitted: {formatDate(offer.submittedAt)}</p>
        <p>Viewed: {offer.viewedAt ? formatDate(offer.viewedAt) : '-'}</p>
        <p>Accepted: {offer.acceptedAt ? formatDate(offer.acceptedAt) : '-'}</p>
        <p>Rejected: {offer.rejectedAt ? formatDate(offer.rejectedAt) : '-'}</p>
        <p>Withdrawn: {offer.withdrawnAt ? formatDate(offer.withdrawnAt) : '-'}</p>
      </section>
      <section>
        <h2>Provider</h2>
        <p>{offer.provider.businessName}</p>
        <p>{offer.provider.contactName}</p>
        <p>{offer.provider.phone}</p>
        <p>{offer.provider.email ?? '-'}</p>
      </section>
      <section>
        <h2>Request</h2>
        <p>{offer.request.category.name}</p>
        <p>
          {offer.request.city}/{offer.request.district}
        </p>
        <p>Quality: {offer.request.qualityScore}</p>
      </section>
      <section>
        <h2>Status</h2>
        <form action={updateOfferStatusAction}>
          <input type="hidden" name="id" value={offer.id} />
          <select name="status" defaultValue={offer.status}>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button type="submit">Save status</button>
        </form>
      </section>
      <section>
        <h2>Credit refund</h2>
        {offer.creditRefundedAt ? (
          <p>This offer credit was already refunded.</p>
        ) : offer.creditSpentTransactionId ? (
          <form action={refundOfferCreditAction}>
            <input type="hidden" name="id" value={offer.id} />
            <p>
              <label>
                Reason *
                <textarea name="reason" required />
              </label>
            </p>
            <button type="submit">Refund credit</button>
          </form>
        ) : (
          <p>This offer has no credit spend transaction.</p>
        )}
      </section>
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
