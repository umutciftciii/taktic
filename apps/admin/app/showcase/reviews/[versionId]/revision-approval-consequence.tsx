/**
 * The runs a revision approval re-pins, as `ShowcasePlacementService.repinToVersion`
 * picks them: every placement of the card that is not over yet.
 */
export const REPINNED_PLACEMENT_STATUSES = ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'] as const;

/**
 * How many of the card's runs the approval moves, read from the placements the
 * API lists — or null when this session may not read placements, or the read
 * failed. The dialog then says it cannot show a number; it never guesses one.
 */
export type RevisionPlacementImpact = { live: number; onAir: number } | null;

/**
 * What approving a revision of a live card does, said before it happens
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). It follows
 * `AdminShowcaseService.approveVersion` on a card that already has a live
 * version:
 *
 * 1. the new version becomes the card's live one, in the same transaction
 *    every run of the card is re-pinned to it (`repinToVersion`) — the
 *    shelves are rebuilt from its areas, the end date is untouched;
 * 2. no right is spent;
 * 3. there is no route, in the panel or the API, that puts the previous
 *    version back — the provider has to send it again for review;
 * 4. after the commit the provider is mailed the outcome.
 */
export function RevisionApprovalConsequence({
  liveVersionNumber,
  nextVersionNumber,
  impact,
}: {
  liveVersionNumber: number;
  nextVersionNumber: number;
  impact: RevisionPlacementImpact;
}) {
  return (
    <ul data-testid="showcase-revision-approve-impact">
      <li>
        <strong>
          {nextVersionNumber}. sürüm, yayındaki {liveVersionNumber}. sürümün yerini alır.
        </strong>{' '}
        Kartın müşteriye gösterilen başlığı, metni, fiyatı, yanıt taahhüdü, dahil/hariç maddeleri ve bölgeleri bu
        sürümden okunur.
      </li>
      <li data-testid="showcase-revision-approve-placements">
        <strong>Bütün aktif yerleşimler yeni sürüme geçer:</strong>{' '}
        {impact === null
          ? 'bu kartın yerleşim sayısı bu ekranda gösterilemiyor (yerleşimleri görme yetkiniz yok ya da okunamadı); kartın her yerleşimi yeni metni göstermeye başlar.'
          : impact.live === 0
            ? 'bu kartın şu anda bitmemiş bir yerleşimi yok; yeni sürüm kartın kendi sayfasında görünür.'
            : `bu kartın bitmemiş ${impact.live} yerleşimi var (${impact.onAir} tanesi şu anda yayında); hepsi yeni sürümü göstermeye başlar ve raflar yeni sürümün bölgelerinden yeniden kurulur. Bitiş tarihleri değişmez.`}
      </li>
      <li>
        <strong>Eski sürüme dönüş yok:</strong> panelde ya da API&apos;de önceki sürümü geri yayına alan bir işlem
        yoktur. Eski metin ancak hizmet veren onu yeni bir sürüm olarak yeniden gönderir ve onaylanırsa döner.
      </li>
      <li>
        <strong>Sonuç bildirilir:</strong> kartın sahibi hizmet verene değişikliğin onaylandığını söyleyen e-posta
        gider. Yayın hakkı harcanmaz.
      </li>
    </ul>
  );
}
