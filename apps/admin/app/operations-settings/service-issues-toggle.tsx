'use client';

import { ConfirmDialog } from '../../components/confirm-dialog';
import { toggleServiceIssuesAction } from './actions';

/**
 * REL-002 Faz 3 — the customer service-issue switch. Same shape as the
 * reviews switch: both directions ask first, each with its own proof.
 */
export function ServiceIssuesToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleServiceIssuesAction} className="setting-toggle-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? (
        <ConfirmDialog
          proof="operations.service-issues-disable"
          triggerLabel="Hizmet aksaklığı bildirimi"
          triggerClassName="toggle"
          switchChecked
          tone="primary"
          title="Hizmet aksaklığı bildirimi kapatılsın mı?"
          consequence={
            <>
              <p>
                Müşteriler eşleşmiş taleplerinde artık <strong>sorun bildiremez</strong>; buton hiçbir ekranda görünmez.
              </p>
              <p>
                Daha önce açılmış turlar, dışlamalar ve kayıtlar <strong>geri alınmaz</strong>. Değişiklik adınızla kayda geçer.
              </p>
            </>
          }
          confirmLabel="Evet, kapat"
          testId="service-issues-toggle"
        />
      ) : (
        <ConfirmDialog
          proof="operations.service-issues-enable"
          triggerLabel="Hizmet aksaklığı bildirimi"
          triggerClassName="toggle"
          switchChecked={false}
          tone="primary"
          title="Hizmet aksaklığı bildirimi açılsın mı?"
          consequence={
            <>
              <p>
                Müşteri, eşleşmiş talebinde hizmet veren gelmez ya da işi yapmazsa eşleşmeyi kapatabilir: hizmet veren o
                talepten <strong>kalıcı olarak dışlanır</strong> ve talep yeniden teklife açılır (en fazla 3 otomatik tur).
              </p>
              <p>
                Başarısız eşleşmenin kredisi <strong>iade edilmez</strong>. Değişiklik adınızla kayda geçer.
              </p>
            </>
          }
          confirmLabel="Evet, aç"
          testId="service-issues-toggle"
        />
      )}
    </form>
  );
}
