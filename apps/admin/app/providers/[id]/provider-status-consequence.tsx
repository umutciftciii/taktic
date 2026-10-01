import type { ReactNode } from 'react';
import type { ProviderStatus } from '../../../lib/api';

/**
 * The provider status moves an operator can make, and what the confirmation in
 * front of the stopping ones says. Plain module (no 'use client'): the server
 * page draws the header's quick "Askıya al" with it and the client status
 * form draws its confirmation with it, so both say the same thing.
 */

export const PROVIDER_STATUSES: readonly ProviderStatus[] = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];

export const PROVIDER_STATUS_LABELS: Record<ProviderStatus, string> = {
  DRAFT: 'Taslak',
  PENDING_REVIEW: 'İnceleme bekliyor',
  APPROVED: 'Onaylandı',
  REJECTED: 'Reddedildi',
  SUSPENDED: 'Askıya alındı',
};

/**
 * What `PATCH /providers/:id/status` does to a provider moving from `from` to
 * `to` (providers.service.ts `updateProviderStatus`), or null when the move
 * takes nothing away and needs no confirmation.
 *
 * A move is confirmed here when it rejects, suspends, or takes an approved
 * business out of approval by any other route — each of those stops the
 * business working. Approving and moving into DRAFT have their own
 * confirmations since Faz 2 (`providerApproveConsequence`,
 * `providerDraftConsequence`); `providerStatusProofKey` decides which applies.
 */
export function providerStatusConsequence(from: ProviderStatus, to: ProviderStatus): ReactNode | null {
  if (from === to) return null;
  const leavesApproval = from === 'APPROVED' && to !== 'APPROVED';
  if (!leavesApproval && to !== 'REJECTED' && to !== 'SUSPENDED') return null;

  return (
    <>
      {to === 'REJECTED' ? (
        <p>Başvuru reddedilir; yazdığınız ret gerekçesi kayda geçer.</p>
      ) : to === 'SUSPENDED' ? (
        <p>İşletme askıya alınır.</p>
      ) : (
        <p>İşletme “{PROVIDER_STATUS_LABELS[to]}” durumuna geçer ve onaylı olmaktan çıkar.</p>
      )}
      <p>
        Onaylı olmayan işletme yeni talepleri göremez ve teklif veremez.
        {leavesApproval
          ? ' Yayındaki vitrin kartları hemen yayından kalkar; ödenmiş vitrin süresi bu sırada işlemeye devam eder.'
          : ''}
        {to !== 'PENDING_REVIEW' ? ' Kullanılmamış sahiplenme (claim) davet bağlantıları geçersiz olur.' : ''}
      </p>
      <p>
        Mevcut teklifleri, kredisi ve geçmişi silinmez; işletmeye otomatik e-posta gitmez. Durum
        sonradan yine buradan değiştirilebilir
        {leavesApproval ? '; yeniden onay, vitrin yayınlarını sürdürür.' : '.'}
      </p>
    </>
  );
}


/**
 * What a move into APPROVED does (providers.service.ts `updateProviderStatus`):
 * the business may see and offer on matching requests; placements suspended
 * because it was not approved go back on the air; it is mailed that it was
 * approved; and the PROVIDER_APPROVED campaign hook is booked. Worded by the
 * status it leaves, because "approve an application" and "let a suspended
 * business work again" are different decisions.
 */
export function providerApproveConsequence(from: ProviderStatus): ReactNode {
  return (
    <>
      {from === 'SUSPENDED' ? (
        <p>Askıya alınmış işletme yeniden onaylı (aktif) olur.</p>
      ) : from === 'REJECTED' ? (
        <p>Reddedilmiş başvuru onaylanır; kayıtlı ret gerekçesi silinir.</p>
      ) : from === 'DRAFT' ? (
        <p>Henüz incelemeye gönderilmemiş (taslak) başvuru inceleme adımı atlanarak doğrudan onaylanır.</p>
      ) : (
        <p>İncelemedeki başvuru onaylanır ve işletme onaylı olur.</p>
      )}
      <p>
        Onaylı işletme hizmet kategorileri ve bölgeleriyle eşleşen yayındaki talepleri görebilir ve kredisiyle teklif
        verebilir. İşletme onaylı olmadığı için askıya alınmış vitrin yayınları varsa yeniden yayına girer.
      </p>
      <p>
        İşletmeye başvurusunun onaylandığını bildiren e-posta gider
        {from === 'SUSPENDED' ? ' (yeniden onay yeni bir onay sayılır; e-posta tekrar gider)' : ''}. Kampanya motoru
        açıksa ve “hizmet veren onaylandı” koşullu bir kampanya uygunsa bu onay kampanya ödülünü (ör. promosyon
        kredisi) tetikleyebilir.
      </p>
      <p>Durum sonradan yine buradan değiştirilebilir; gönderilen e-posta ve verilen ödül bununla geri alınmaz.</p>
    </>
  );
}

/**
 * What a move into DRAFT does, from anything but APPROVED (that one stops a
 * working business and is `providerStatusConsequence`'s): unused claim links
 * are voided in the same transaction, and a REJECTED application loses its
 * stored rejection reason. Nothing is mailed.
 */
export function providerDraftConsequence(from: ProviderStatus): ReactNode {
  return (
    <>
      {from === 'REJECTED' ? (
        <p>Reddedilmiş başvuru taslağa döner; kayıtlı ret gerekçesi silinir.</p>
      ) : from === 'SUSPENDED' ? (
        <p>Askıdaki işletme taslağa döner.</p>
      ) : (
        <p>Başvuru taslağa döner ve inceleme kuyruğundan çıkar.</p>
      )}
      <p>
        Kullanılmamış sahiplenme (claim) davet bağlantıları geçersiz olur. Taslaktaki başvuruya yeni sahiplenme
        daveti de gönderilemez; davet için başvurunun yeniden incelemeye alınması gerekir.
      </p>
      <p>
        Taslaktaki işletme onaylı değildir: yeni talepleri göremez ve teklif veremez. Mevcut teklifleri, kredisi ve
        geçmişi silinmez; işletmeye otomatik e-posta gitmez.
      </p>
    </>
  );
}
