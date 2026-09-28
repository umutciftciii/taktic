'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { cancelOwnRequestAction } from './actions';

/**
 * "Talebi iptal et" for the customer (PR #118). Drawn only while no offer is
 * accepted; the API refuses a matched request anyway. A native `<dialog>`
 * after the report dialog's precedent: nothing is posted until the customer
 * confirms, and Esc or "Vazgeç" leaves the request as it is.
 */
export function CancelRequestDialog({ requestId, liveOfferCount }: { requestId: string; liveOfferCount: number }) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="cdash-btn cdash-btn-secondary"
        onClick={() => dialog.current?.showModal()}
        data-testid="customer-cancel-request"
      >
        Talebi iptal et
      </button>

      <dialog
        ref={dialog}
        className="report-dialog"
        aria-labelledby="customer-cancel-title"
        data-testid="customer-cancel-dialog"
      >
        <form action={cancelOwnRequestAction} className="customer-cancel-form">
          <input type="hidden" name="requestId" value={requestId} />
          <h2 id="customer-cancel-title">Talep iptal edilsin mi?</h2>
          <p>
            Talebiniz hizmet verenlere artık gösterilmez ve yeni teklif alamaz. İptal geri alınamaz; ihtiyacınız sürerse
            yeni bir talep oluşturabilirsiniz.
          </p>
          <p>
            {liveOfferCount > 0
              ? `Gelen ${liveOfferCount} teklif kapatılır; teklif veren hizmet verenlere talebin iptal edildiği bildirilir.`
              : 'Teklif veren olursa, talebin iptal edildiği kendilerine bildirilir.'}{' '}
            Size de iptal teyidi e-postası gönderilir.
          </p>
          <div className="report-dialog-actions">
            <button type="button" className="cdash-btn cdash-btn-secondary" onClick={() => dialog.current?.close()}>
              Vazgeç
            </button>
            <ConfirmButton />
          </div>
        </form>
      </dialog>
    </>
  );
}

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button className="cdash-btn cdash-btn-primary" type="submit" disabled={pending} data-testid="customer-cancel-confirm">
      Evet, iptal et
    </button>
  );
}
