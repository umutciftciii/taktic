/**
 * What a manual correction of a pending purchase really does, written from
 * `PackagePurchasesService.updateAdminPurchaseStatus` and the payment webhook
 * (ADMIN-DESIGN-001 Faz 3D). It is the body of the confirmation dialog, so it
 * says it before anything is written:
 *
 * - The purchase leaves PENDING for good: the API only corrects a pending one,
 *   and there is no way back.
 * - No money and no credit moves. A payment that completes afterwards is not
 *   turned into credit — the webhook settles only a pending purchase.
 * - The note typed here replaces the purchase's admin note (empty clears it).
 * - Only a cancelled *vitrin* purchase mails the provider (the "payment did not
 *   complete" notice); an expiry, or any credit package, sends nothing.
 */
export function PurchaseStatusConsequence({
  status,
  kind,
}: {
  status: 'CANCELLED' | 'EXPIRED';
  kind?: 'OFFER_PACKAGE' | 'SHOWCASE_PACKAGE';
}) {
  const label = status === 'CANCELLED' ? '“İptal”' : '“Süresi doldu”';
  const mailed = status === 'CANCELLED' && kind === 'SHOWCASE_PACKAGE';
  return (
    <>
      <p>
        Satın alma {label} durumuna geçer ve bir daha “Bekliyor”a dönmez. Para ve kredi hareket etmez: bakiyeye kredi
        eklenmez, bakiyeden kredi düşülmez.
      </p>
      <p>
        Bu ödeme oturumu sonradan tamamlanırsa gelen ödeme bildirimi kredi yüklemez; o tahsilat ödeme sağlayıcısının
        panelinden incelenmelidir.
      </p>
      <p>Yazdığınız not satın almanın yönetici notunun yerine geçer; boş bırakırsanız mevcut not silinir.</p>
      <p>
        {mailed
          ? 'Bu bir vitrin paketi: hizmet verene ödemenin tamamlanmadığını bildiren bir e-posta gider. Not e-postaya eklenmez.'
          : status === 'CANCELLED' && kind === undefined
            ? 'Vitrin paketiyse hizmet verene ödemenin tamamlanmadığını bildiren bir e-posta gider; kredi paketinde e-posta gitmez.'
            : 'Hizmet verene e-posta gitmez.'}
      </p>
    </>
  );
}
