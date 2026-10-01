/**
 * What approving a card's first version does, said before it happens
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001). It follows
 * `AdminShowcaseService.approveVersion` on a card with nothing live:
 *
 * 1. the reserved right is spent (`consumeForCard`) and the paid run starts
 *    now (`startAt: now`) — approval and publication are one fact;
 * 2. the card becomes "Onaylı" and appears on the vitrin shelves;
 * 3. after the commit the provider is sent the "approved and live" mail;
 * 4. there is no route that takes an approval back or returns a spent right.
 *
 * A revision approval (something already live) spends nothing and is not
 * asked here; that is Faz 4.
 */
export function FirstApprovalConsequence({
  businessName,
  entitlement,
}: {
  businessName: string;
  /** The right the card was opened on, as the review read it. */
  entitlement: { packageName: string; durationDays: number } | null;
}) {
  return (
    <ul data-testid="showcase-approve-impact">
      <li>
        <strong>Yayın hakkı tüketilir:</strong>{' '}
        {entitlement
          ? `${entitlement.packageName} paketinden gelen ${entitlement.durationDays} günlük hak bu karta harcanır ve yayın süresi şimdi başlar.`
          : 'kartın yayın hakkı bu karta harcanır ve yayın süresi şimdi başlar.'}
      </li>
      <li>
        <strong>Kart yayına girer:</strong> “Onaylı” olur ve vitrin raflarında müşterilere görünür; bu sürümdeki başlık,
        metin, fiyat ve bölgeler gösterilir, karttan talep gelebilir.
      </li>
      <li>
        <strong>Sonuç bildirilir:</strong> {businessName} adına kayıtlı hizmet verene kartın onaylanıp yayına girdiğini
        söyleyen e-posta gider.
      </li>
      <li>
        <strong>Karar geri alınamaz:</strong> onay geri çekilemez ve tüketilen hak iade edilmez. Kartı yayından indirmek
        ayrı bir işlemdir (kartı askıya alma ya da yerleşimi iptal etme).
      </li>
    </ul>
  );
}
