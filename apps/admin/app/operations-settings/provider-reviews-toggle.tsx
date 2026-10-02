'use client';

import { ConfirmDialog } from '../../components/confirm-dialog';
import { toggleProviderReviewsAction } from './actions';

/**
 * The provider-review switch.
 *
 * A `role="switch"` submit button inside its own form, so it works without
 * JavaScript and reads to a screen reader as the setting's state rather than
 * as an action beside it. Its own component: the switches share a shape, not
 * a meaning.
 *
 * The payload is only the state being asked for, computed here from what is
 * currently true, so a double submission asks for the same thing twice and
 * the API records one change.
 *
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A: both directions ask first, each
 * with its own proof — `operations.reviews-enable` (existing reviews become
 * public again, invitations start going out) and `operations.reviews-disable`
 * (every surface hides them; nothing is deleted).
 */
export function ProviderReviewsToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleProviderReviewsAction} className="setting-toggle-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? (
        <ConfirmDialog
          proof="operations.reviews-disable"
          triggerLabel="Hizmet veren değerlendirmeleri"
          triggerClassName="toggle"
          switchChecked
          tone="primary"
          title="Değerlendirmeler kapatılsın mı?"
          consequence={
            <>
              <p>
                Değerlendirmeler public profil, teklif kartları ve diğer tüm yüzeylerde <strong>gizlenir</strong>; müşteri
                yeni değerlendirme yazamaz ve değerlendirme daveti gönderilmez.
              </p>
              <p>
                Hiçbir değerlendirme <strong>silinmez</strong>: yeniden açıldığında aynen görünür. Değişiklik adınızla kayda
                geçer.
              </p>
            </>
          }
          confirmLabel="Evet, değerlendirmeleri kapat"
          testId="provider-reviews-toggle"
        />
      ) : (
        <ConfirmDialog
          proof="operations.reviews-enable"
          triggerLabel="Hizmet veren değerlendirmeleri"
          triggerClassName="toggle"
          switchChecked={false}
          tone="primary"
          title="Değerlendirmeler açılsın mı?"
          consequence={
            <>
              <p>
                Mevcut değerlendirmeler public profil ve teklif kartlarında <strong>yeniden görünür hâle gelebilir</strong>{' '}
                (moderasyonda kaldırılmış olanlar kaldırılmış kalır).
              </p>
              <p>
                Değerlendirme ve davet akışı başlar: bundan sonra tamamlanan işlerde müşteriye değerlendirme daveti gider
                ve müşteri değerlendirme yazabilir. Değişiklik adınızla kayda geçer.
              </p>
            </>
          }
          confirmLabel="Evet, değerlendirmeleri aç"
          testId="provider-reviews-toggle"
        />
      )}
    </form>
  );
}
