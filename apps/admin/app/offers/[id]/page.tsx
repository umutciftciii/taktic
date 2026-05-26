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

const refundReasonCodes = [
  'NOT_VIEWED_48H',
  'VIEWED_MANUAL_REVIEW',
  'INVALID_REQUEST',
  'CUSTOMER_UNREACHABLE',
  'DUPLICATE_REQUEST',
  'ADMIN_OVERRIDE',
  'OTHER',
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
        <div>
          <h3>Refund eligibility</h3>
          <p>Eligible: {offer.refundEligibility.eligible ? 'Yes' : 'No'}</p>
          <p>Recommended action: {offer.refundEligibility.recommendedAction}</p>
          <p>Reason code: {offer.refundEligibility.reasonCode}</p>
          <p>Reason label: {offer.refundEligibility.reasonLabel}</p>
          <p>Details: {offer.refundEligibility.details}</p>
          <p>Hours since submitted: {offer.refundEligibility.hoursSinceSubmitted ?? '-'}</p>
        </div>
        {offer.creditRefundedAt ? (
          <p>This offer credit was already refunded.</p>
        ) : offer.creditSpentTransactionId ? (
          <form action={refundOfferCreditAction}>
            <input type="hidden" name="id" value={offer.id} />
            <p>
              <label>
                Reason code *
                <select name="reasonCode" defaultValue={offer.refundEligibility.reasonCode}>
                  {refundReasonCodes.map((reasonCode) => (
                    <option key={reasonCode} value={reasonCode}>
                      {reasonCode}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                Admin note
                <textarea name="reason" />
              </label>
            </p>
            {offer.refundEligibility.recommendedAction === 'NO_REFUND' ? (
              <p>
                <label>
                  <input type="checkbox" name="override" value="true" /> Override no-refund recommendation
                </label>
              </p>
            ) : null}
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
