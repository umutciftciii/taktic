'use client';

import { useFormStatus } from 'react-dom';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { Toggle } from '../../components/toggle';
import { toggleAutoPublishAction } from './actions';

/**
 * The marketplace auto-publish switch.
 *
 * A `role="switch"` submit button inside its own form, so it works without
 * JavaScript and reads to a screen reader as the setting's state rather than
 * as an action beside it. Kept as its own component rather than a generalised
 * one: the switches share a shape, not a meaning, and a shared component would
 * need a prop to say which endpoint it posts to.
 *
 * The payload is only the state being asked for, computed here from what is
 * currently true, so a double submission asks for the same thing twice and the
 * API records one change. `useFormStatus` disables the switch for the life of
 * the submission.
 *
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A: switching it *on* asks first
 * (ConfirmDialog drawn as the same switch, proof
 * `operations.auto-publish-enable`): from then on a new request reaches
 * providers without a moderator having read it. Switching it off stays one
 * tap — it only sends the next request back to the queue.
 */
export function AutoPublishToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleAutoPublishAction} className="setting-toggle-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {enabled ? (
        <OffSwitch />
      ) : (
        <ConfirmDialog
          proof="operations.auto-publish-enable"
          triggerLabel="Pazar talepleri otomatik yayınlansın"
          triggerClassName="toggle"
          switchChecked={false}
          tone="primary"
          title="Otomatik yayın açılsın mı?"
          consequence={
            <>
              <p>
                Bundan sonra gönderilen pazar talepleri <strong>moderasyon beklemeden</strong> yayınlanabilir ve eşleşen
                hizmet verenlere iletilir; bir moderatör talebi yayından önce okumaz.
              </p>
              <p>
                Onay kuyruğunda bekleyen talepler kendiliğinden yayınlanmaz. Kapatmak onay istemez ve yalnız bundan sonraki
                talepleri kuyruğa geri gönderir. Değişiklik adınızla kayda geçer.
              </p>
            </>
          }
          confirmLabel="Evet, otomatik yayını aç"
          testId="auto-publish-toggle"
        />
      )}
    </form>
  );
}

function OffSwitch() {
  const { pending } = useFormStatus();
  return (
    <Toggle
      type="submit"
      checked
      label="Pazar talepleri otomatik yayınlansın"
      stateText={pending ? { on: 'Kaydediliyor…', off: 'Kaydediliyor…' } : undefined}
      disabled={pending}
      testId="auto-publish-toggle"
    />
  );
}
