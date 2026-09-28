'use client';

import { useId, useState } from 'react';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { cancelRequestAction } from '../actions';

/** The shortest reason the API accepts for keeping the winner's credit (CANCEL_WITHHOLD_REASON_MIN_LENGTH). */
export const WITHHOLD_REASON_MIN_LENGTH = 10;

/** What the cancel will find on the request, counted by the page from its own offer list. */
export type CancelOfferCounts = {
  /** SUBMITTED / VIEWED / SHORTLISTED offers other than the accepted one: closed and refunded. */
  live: number;
  /** REJECTED because another offer was accepted (COMPETITOR_ACCEPTED): refunded. */
  competitorRejected: number;
  /** REJECTED with no such evidence (decided by hand): left as they are. */
  otherRejected: number;
  /** The accepted offer spent a one-time credit that has not come back. */
  winnerRefundable: boolean;
  winnerCreditCost: number;
} | null;

/**
 * The operations cancel (PR #118 contract).
 *
 * On a matched request, "Kazanan teklifin kredisini iade et" is shown checked.
 * Unchecking it needs REQUESTS_CANCEL_WITHOUT_REFUND (otherwise the box is
 * checked and disabled) and makes a written reason required. The box itself
 * carries no name: what the server reads is the hidden `winnerRefund` field,
 * which is `refund` unless the box was unchecked here — so a missing field is
 * never a withheld refund, and the server action treats anything other than
 * `withhold` as a refund.
 *
 * On an unmatched request there is no winner and no box.
 */
export function CancelRequestForm({
  requestId,
  matchedOfferId,
  canWithhold,
  counts,
}: {
  requestId: string;
  matchedOfferId: string | null;
  canWithhold: boolean;
  counts: CancelOfferCounts;
}) {
  const matched = matchedOfferId !== null;
  const [refundWinner, setRefundWinner] = useState(true);
  const reasonId = useId();
  const withholding = matched && !refundWinner;

  return (
    <form action={cancelRequestAction} className="status-cancel-form" data-testid="request-cancel-form">
      <input type="hidden" name="id" value={requestId} />
      <input type="hidden" name="expectedMatchedOfferId" value={matchedOfferId ?? ''} />
      <input type="hidden" name="winnerRefund" value={withholding ? 'withhold' : 'refund'} />
      {matched ? (
        <div className="status-cancel-options">
          <label className="status-cancel-check">
            <input
              type="checkbox"
              checked={refundWinner}
              disabled={!canWithhold}
              onChange={(event) => setRefundWinner(event.target.checked)}
              data-testid="request-cancel-refund-winner"
            />
            <span>Kazanan teklifin kredisini iade et</span>
          </label>
          {canWithhold ? null : (
            <p className="status-reject-note" role="note" data-testid="request-cancel-refund-locked">
              Kredi iadesiz iptal ayrı yetki ister; bu hesapla kazanan teklifin kredisi iade edilir.
            </p>
          )}
          {withholding ? (
            <label className="status-reject-field" htmlFor={reasonId}>
              <span>İadesiz iptal gerekçesi (zorunlu)</span>
              <textarea
                id={reasonId}
                name="withholdReason"
                required
                minLength={WITHHOLD_REASON_MIN_LENGTH}
                maxLength={1000}
                placeholder="Yalnız yöneticiler görür; hizmet verene gönderilmez."
                data-testid="request-cancel-withhold-reason"
              />
            </label>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        triggerLabel="İptal et"
        triggerClassName="btn btn-destructive btn-sm status-action-btn"
        title="Talep iptal edilsin mi?"
        consequence={<CancelConsequence matched={matched} withholding={withholding} counts={counts} />}
        confirmLabel="Evet, iptal et"
        testId="request-cancel"
      />
    </form>
  );
}

/**
 * What `POST /service-requests/:id/cancel` does, as the API is written
 * (ServiceRequestsService.cancelServiceRequest, cancelLoserOfferRule). The
 * counts come from the request's own offer list; a REJECTED offer is called
 * "rejected because another offer was accepted" only when the record says so.
 */
function CancelConsequence({
  matched,
  withholding,
  counts,
}: {
  matched: boolean;
  withholding: boolean;
  counts: CancelOfferCounts;
}) {
  return (
    <>
      <p>
        Talep “İptal edildi” durumuna geçer ve hizmet verenlere gösterilmez. Vitrinden geldiyse işletmeyle açılan kayıt
        da kapanır. İptal geri alınamaz.
      </p>
      {matched ? (
        <p data-testid="request-cancel-winner">
          Kabul edilen teklif kapatılır ve eşleşme sona erer; iletişim bilgileri ve mesajlaşma kapanır, kabulün kaydı
          saklanır.{' '}
          {withholding
            ? 'Kazanan teklifin kredisi iade edilmez; gerekçeniz iptal kaydında saklanır.'
            : counts && !counts.winnerRefundable
              ? 'Kazanan teklif için iade edilecek bir kredi harcaması yok.'
              : `Kazanan teklifin ${counts ? `${counts.winnerCreditCost} ` : ''}kredisi iade edilir.`}
        </p>
      ) : null}
      <p data-testid="request-cancel-other-offers">
        {counts === null
          ? `Açık teklifler (gönderildi, görüntülendi, kısa listede) kapatılır ve harcanan kredileri iade edilir.${
              matched ? ' Başka teklif kabul edildiği için reddedilmiş tekliflerin kredisi de iade edilir; elle reddedilmiş teklifler olduğu gibi kalır.' : ''
            }`
          : counts.live > 0
            ? `${matched ? 'Kabul edilen dışında ' : ''}${counts.live} açık teklif (gönderildi, görüntülendi, kısa listede) kapatılır ve harcanan kredileri iade edilir.`
            : matched
              ? 'Kabul edilen dışında açık teklif yok.'
              : 'Bu talepte açık teklif yok.'}
        {counts && matched && counts.competitorRejected > 0
          ? ` Başka teklif kabul edildiği için reddedilmiş ${counts.competitorRejected} teklifin kredisi iade edilir; durumları değişmez.`
          : ''}
        {counts && counts.otherRejected > 0
          ? ` Tek tek reddedilmiş ${counts.otherRejected} teklif olduğu gibi kalır; kredileri iade edilmez.`
          : ''}
      </p>
      <p>
        Daha önce iade edilmiş hiçbir kredi ikinci kez iade edilmez. Müşteriye iptal teyidi, kapanan ya da iadesi yapılan
        tekliflerin sahiplerine sonuç bildirimi gider; bildirimlerde iletişim bilgisi ya da gerekçe yer almaz.
      </p>
    </>
  );
}
