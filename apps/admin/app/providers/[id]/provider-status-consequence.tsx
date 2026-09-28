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
 * A move is confirmed when it rejects, suspends, or takes an approved
 * business out of approval by any other route — each of those stops the
 * business working. Approving is not confirmed: it gives, and mails the
 * business that it did.
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

