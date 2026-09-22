'use client';

import { useFormStatus } from 'react-dom';
import { toggleCampaignEngineAction } from './actions';

/**
 * The campaign engine's switch (CMP-004 S4).
 *
 * Deliberately not the one-tap `role="switch"` the other cards use. This is
 * the one operations switch that starts promotional credit being granted,
 * so it asks twice: a checkbox that says the operator has read what the
 * change does, and a button named after the direction the switch will move.
 * The checkbox is `required` (the browser refuses an unticked submit) and
 * the server action refuses it again, so neither a form without JavaScript
 * nor a hand-built request can throw the switch without the confirmation.
 *
 * The payload is the state being asked for, computed from what is currently
 * true, so a double submission asks for the same thing twice and the API
 * records one change.
 */
export function CampaignEngineToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={toggleCampaignEngineAction} className="campaign-engine-form" data-testid="campaign-engine-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <label className="campaign-engine-confirm">
        <input type="checkbox" name="confirm" value="yes" required data-testid="campaign-engine-confirm" />
        <span>
          {enabled
            ? 'Motoru kapatmanın etkisini anladım: yeni hak ediş durur, mevcut promosyonların iadesi ve geri alınması sürer.'
            : 'Motoru açmanın etkisini anladım: aktif kampanyalar gerçek olaylarda promosyon kredisi vermeye başlar.'}
        </span>
      </label>
      <Submit enabled={enabled} />
    </form>
  );
}

function Submit({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={enabled ? 'btn btn-secondary' : 'btn btn-primary'}
      disabled={pending}
      aria-disabled={pending}
      data-testid="campaign-engine-submit"
    >
      {pending ? 'Kaydediliyor…' : enabled ? 'Motoru kapat' : 'Motoru aç'}
    </button>
  );
}
