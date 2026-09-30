'use client';

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { toggleCampaignEngineAction } from './actions';

/**
 * The campaign engine's switch (CMP-004 S4).
 *
 * The one operations switch that starts promotional credit being granted, so
 * it asks before it moves — in both directions. Until ADMIN-DESIGN-001 Faz 3E
 * the question was a `required` checkbox beside the button; it is now the
 * shared ConfirmDialog, with the switch as its trigger and the checkbox's
 * sentence as the dialog's text.
 *
 * The server action's rule is unchanged: a submission without `confirm=yes`
 * is refused before any request is made. That field is rendered only once
 * this component has hydrated — and a hydrated trigger never submits except
 * through the dialog's confirm — so a click that lands before JavaScript runs
 * posts without it and is refused, exactly as an unticked checkbox was. A
 * hand-built request still has to carry it on purpose.
 *
 * The payload is the state being asked for, computed from what is currently
 * true, so a double submission asks for the same thing twice and the API
 * records one change.
 */
export function CampaignEngineToggle({ enabled }: { enabled: boolean }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <form action={toggleCampaignEngineAction} className="setting-toggle-form" data-testid="campaign-engine-form">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      {hydrated ? <input type="hidden" name="confirm" value="yes" /> : null}
      <ConfirmDialog
        triggerLabel="Kampanya motoru çalışsın"
        triggerClassName="toggle"
        switchChecked={enabled}
        tone={enabled ? 'danger' : 'primary'}
        title={enabled ? 'Kampanya motoru kapatılsın mı?' : 'Kampanya motoru açılsın mı?'}
        consequence={<EngineConsequence enabled={enabled} />}
        confirmLabel={enabled ? 'Evet, motoru kapat' : 'Evet, motoru aç'}
        testId="campaign-engine-submit"
      />
    </form>
  );
}

/** The checkbox's two sentences, and what the API does after each. */
export function EngineConsequence({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <>
      <p>
        Yeni olay kaydı ve değerlendirme durur: bundan sonraki onay, kanıt ya da ödeme için hak ediş üretilmez. Etkin
        kampanyalar tanımlı kalır ama etkinleştirme ve devam ettirme motor yeniden açılana kadar reddedilir.
      </p>
      <p>
        Verilmiş promosyonların teklif iadesi ve ödeme iadesinde geri alınması aynen sürer. Değişiklik adınızla kayda
        geçer.
      </p>
    </>
  ) : (
    <>
      <p>
        Etkin kampanyalar bundan sonraki gerçek olaylarda (onay, kanıt, ödeme) promosyon kredisi vermeye başlar. Motor
        kapalıyken olmuş olaylar için geriye dönük hak ediş üretilmez; etkin kampanya yoksa kimseye kredi verilmez.
      </p>
      <p>Değişiklik adınızla kayda geçer ve motor yalnız bu ekrandan, aynı onayla kapatılır.</p>
    </>
  );
}
