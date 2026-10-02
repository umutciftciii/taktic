import {
  PACKAGE_REFUND_EXCEPTION_GROUND_LABELS,
  PACKAGE_REFUND_EXCEPTION_GROUNDS,
  type PackageRefundDetail,
} from '../../../lib/api';
import { ConfirmDialog } from '../../../components/confirm-dialog';

type FormAction = (formData: FormData) => void | Promise<void>;

export type RefundFormActions = {
  take: FormAction;
  approve: FormAction;
  reject: FormAction;
  markSettlementFailed: FormAction;
};

/**
 * The operator's controls on one package refund request (ADMIN-DESIGN-001
 * Faz 3D).
 *
 * `allowedActions` is the only input that decides what is drawn. The API
 * computes it for this viewer — permission, release gate, terms evidence,
 * current status, today's eligibility and the maker ≠ checker rule
 * (`package-refund-requests.service.ts`) — and this component adds no rule of
 * its own: a false flag draws nothing, not a disabled button, and no flag is
 * ever re-derived from `can()`. There is no "refund completed" control at all:
 * SETTLED is written only by the payment provider's signed refund notice.
 *
 * The four decisions ask first, in the shared confirmation dialog, and say
 * what the API really does (read from the service and the notice outbox):
 * none of them moves money or credit in TakTic, each one mails the provider a
 * status notice without any reason or note, and none can be undone from here.
 * Taking a request into review asks too since ADMIN-DESTRUCTIVE-CONFIRMATION-001
 * Paket A (`package-refund.take`): it mails the provider and makes the taker
 * ineligible to approve. The form actions are passed in, so this renders on its own in a
 * test; the page passes the real server actions.
 */
export function RefundActions({
  refundId,
  allowedActions,
  priceLabel,
  formActions,
}: {
  refundId: string;
  allowedActions: PackageRefundDetail['allowedActions'];
  /** The purchase's price, already formatted, for the dialogs. */
  priceLabel: string;
  formActions: RefundFormActions;
}) {
  const actions = allowedActions;
  return (
    <div className="refund-action-stack">
      {actions.take ? (
        <form action={formActions.take}>
          <input type="hidden" name="id" value={refundId} />
          <ConfirmDialog
            proof="package-refund.take"
            triggerLabel="İşleme al"
            triggerClassName="btn btn-primary btn-sm"
            tone="primary"
            title="İade isteği işleme alınsın mı?"
            consequence={
              <>
                <p>
                  İstek “İnceleniyor” olur ve işleme alan olarak adınız kaydedilir. Hizmet verene isteğin durumunu bildiren
                  bir <strong>e-posta gider</strong>.
                </p>
                <p>
                  <strong>Para ya da kredi hareket etmez.</strong> İşleme aldığınız isteği siz onaylayamazsınız; onayı ikinci
                  bir yetkili verir. Reddetmek için bu kural aranmaz.
                </p>
              </>
            }
            confirmLabel="Evet, işleme al"
            testId="package-refund-take"
          />
        </form>
      ) : null}

      {actions.approveNormal ? (
        <form action={formActions.approve} className="refund-action" data-testid="package-refund-normal-form">
          <input type="hidden" name="id" value={refundId} />
          <input type="hidden" name="kind" value="NORMAL" />
          <p className="refund-action-title">Normal iade</p>
          <p className="detail-muted-note">Satın alma bugünkü değerlendirmeye göre normal iadeye uygun.</p>
          <div className="detail-form-actions">
            <ConfirmDialog
              proof="package-refund.approve"
              triggerLabel="Normal iadeyi onayla"
              triggerClassName="btn btn-primary btn-sm"
              tone="primary"
              title="Normal iade onaylansın mı?"
              consequence={<ApproveConsequence priceLabel={priceLabel} exception={false} />}
              confirmLabel="Evet, iadeyi onayla"
              testId="package-refund-approve-normal"
            />
          </div>
        </form>
      ) : null}

      {actions.approveException ? (
        <form action={formActions.approve} className="refund-action detail-form" data-testid="package-refund-exception-form">
          <input type="hidden" name="id" value={refundId} />
          <input type="hidden" name="kind" value="EXCEPTION" />
          <p className="refund-action-title">İstisna onayı</p>
          <label className="detail-form-field" htmlFor="exception-ground">
            <span>İstisna gerekçesi</span>
            <select id="exception-ground" name="exceptionGround" required defaultValue="">
              <option value="" disabled>
                Seçin
              </option>
              {PACKAGE_REFUND_EXCEPTION_GROUNDS.map((ground) => (
                <option key={ground} value={ground}>
                  {PACKAGE_REFUND_EXCEPTION_GROUND_LABELS[ground]}
                </option>
              ))}
            </select>
          </label>
          <label className="detail-form-field" htmlFor="exception-reason">
            <span>Açıklama (10–1000 karakter, denetim kaydına yazılır)</span>
            <textarea id="exception-reason" name="exceptionReason" rows={3} required minLength={10} maxLength={1000} />
          </label>
          <div className="detail-form-actions">
            <ConfirmDialog
              proof="package-refund.approve"
              triggerLabel="İstisna olarak onayla"
              triggerClassName="btn btn-primary btn-sm"
              tone="primary"
              title="İade istisna olarak onaylansın mı?"
              consequence={<ApproveConsequence priceLabel={priceLabel} exception />}
              confirmLabel="Evet, istisna olarak onayla"
              testId="package-refund-approve-exception"
            />
          </div>
        </form>
      ) : null}

      {actions.reject ? (
        <form action={formActions.reject} className="refund-action detail-form" data-testid="package-refund-reject-form">
          <input type="hidden" name="id" value={refundId} />
          <p className="refund-action-title">Reddet</p>
          <label className="detail-form-field" htmlFor="reject-reason">
            <span>Ret gerekçesi (10–1000 karakter, hizmet verene gösterilmez)</span>
            <textarea id="reject-reason" name="reason" rows={3} required minLength={10} maxLength={1000} />
          </label>
          <div className="detail-form-actions">
            <ConfirmDialog
              proof="package-refund.reject"
              triggerLabel="İsteği reddet"
              triggerClassName="btn btn-destructive btn-sm"
              title="İade isteği reddedilsin mi?"
              consequence={
                <>
                  <p>
                    İstek “Reddedildi” olur ve bu istek bir daha işleme alınamaz ya da onaylanamaz. Para ve kredi hareket
                    etmez.
                  </p>
                  <p>
                    Gerekçe adınızla denetim kaydına yazılır ve hizmet verene gösterilmez. Hizmet verene yalnız isteğin
                    durumunu bildiren bir e-posta gider.
                  </p>
                </>
              }
              confirmLabel="Evet, isteği reddet"
              testId="package-refund-reject"
            />
          </div>
        </form>
      ) : null}

      {actions.markSettlementFailed ? (
        <form
          action={formActions.markSettlementFailed}
          className="refund-action detail-form"
          data-testid="package-refund-failed-form"
        >
          <input type="hidden" name="id" value={refundId} />
          <p className="refund-action-title">Ödeme iadesi tamamlanamadı</p>
          <label className="detail-form-field" htmlFor="failed-reason">
            <span>Ödeme iadesi neden tamamlanamadı? (10–1000 karakter)</span>
            <textarea id="failed-reason" name="reason" rows={3} required minLength={10} maxLength={1000} />
          </label>
          <div className="detail-form-actions">
            <ConfirmDialog
              proof="package-refund.settlement-failed"
              triggerLabel="Ödeme iadesi tamamlanamadı olarak kaydet"
              triggerClassName="btn btn-secondary btn-sm"
              title="Ödeme iadesi tamamlanamadı olarak kaydedilsin mi?"
              consequence={
                <>
                  <p>
                    İstek “Ödeme iadesi tamamlanamadı” olur. Para ve kredi hareket etmez; yalnız onaylanan iadenin
                    gerçekleşmediği adınızla ve gerekçesiyle kaydedilir.
                  </p>
                  <p>
                    Ödeme sağlayıcısından tam iadeyi kanıtlayan imzalı bir bildirim sonradan gelirse istek yine
                    kendiliğinden tamamlanır; TakTic&apos;te elle tamamlanamaz.
                  </p>
                  <p>Hizmet verene isteğin durumunu bildiren bir e-posta gider; gerekçe e-postaya eklenmez.</p>
                </>
              }
              confirmLabel="Evet, tamamlanamadı olarak kaydet"
              testId="package-refund-mark-failed"
            />
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ApproveConsequence({ priceLabel, exception }: { priceLabel: string; exception: boolean }) {
  return (
    <>
      <p>
        İstek “Onaylandı, ödeme iadesi bekleniyor” olur. Onayla birlikte TakTic&apos;te para ya da kredi hareket etmez:
        ödeme iadesini ödeme sağlayıcısının panelinde <strong>tam tutar ({priceLabel})</strong> olarak siz yaparsınız.
        İstek, imzalı iade bildirimi gelince kendiliğinden tamamlanır.
      </p>
      <p>
        Uygunluk onay anında yeniden hesaplanır; bu sayfa açıldıktan sonra koşullar değiştiyse onay reddedilir ve
        hiçbir şey yazılmaz.
      </p>
      {exception ? (
        <p>İstisna gerekçesi ve açıklaması onaylayan olarak adınızla denetim kaydına yazılır.</p>
      ) : null}
      <p>İsteği açan ya da işleme alan kişi onay veremez; sunucu da bunu reddeder.</p>
      <p>
        Onay geri alınamaz; iade yapılamazsa yalnız “Ödeme iadesi tamamlanamadı” kaydı düşülebilir. Hizmet verene
        isteğin durumunu bildiren bir e-posta gider.
      </p>
    </>
  );
}
