'use client';

import { useActionState } from 'react';
import type { Campaign, CampaignVersionSummary } from '../../lib/api';
import { ruleErrorMessage } from '../../lib/campaign-rules';
import { campaignLifecycleAction } from './actions';
import { IDLE_CAMPAIGN_LIFECYCLE_STATE } from './lifecycle-state';

type CampaignLifecyclePanelProps = {
  campaign: Campaign;
  engineEnabled: boolean;
  activeVersion: CampaignVersionSummary | null;
  currentVersion: CampaignVersionSummary | null;
};

/**
 * The lifecycle desk of one campaign (CMP-002 S2B2).
 *
 * Exactly the moves the API allows are offered: a DRAFT can be activated, an
 * ACTIVE campaign paused or ended (and a newer version activated in place of
 * the running one), a PAUSED campaign resumed or ended, an ENDED campaign
 * nothing. Activation and resumption are shown disabled — with the sentence
 * that explains why — while the engine switch is off, because the API would
 * refuse them with CAMPAIGN_ENGINE_DISABLED and a screen must not offer an
 * action it knows will come back as an error. Pause and end never need the
 * engine. Nothing here can turn the engine on.
 */
export function CampaignLifecyclePanel({ campaign, engineEnabled, activeVersion, currentVersion }: CampaignLifecyclePanelProps) {
  const [state, submit, pending] = useActionState(campaignLifecycleAction, IDLE_CAMPAIGN_LIFECYCLE_STATE);
  const status = campaign.status;
  // Offer "activate version N" only where it does something a plain resume
  // does not: a first activation, or a swap to a newer stored version.
  const newerVersionStored = currentVersion !== null && currentVersion.id !== activeVersion?.id;
  const canActivate = status === 'DRAFT' || ((status === 'ACTIVE' || status === 'PAUSED') && newerVersionStored);
  const activateVersion = currentVersion;
  const needsEngine = !engineEnabled;

  return (
    <div className="admin-action-panel" data-testid="campaign-lifecycle-panel" data-status={status}>
      <h3>Yaşam döngüsü</h3>
      <p>
        {status === 'DRAFT' && 'Taslak: motor açıkken bir sürüm etkinleştirilerek ACTIVE olur.'}
        {status === 'ACTIVE' && `Etkin — motor sürüm ${activeVersion?.versionNumber ?? '?'} kuralını değerlendiriyor. Kural yerinde değiştirilemez; yeni revizyon kaydedip etkinleştirin.`}
        {status === 'PAUSED' && 'Duraklatıldı: yeni hak ediş üretilmez, mevcut promosyon lotları çalışmaya devam eder.'}
        {status === 'ENDED' && 'Sona erdi: bu kampanya bir daha açılamaz; mevcut lotlar etkilenmez.'}
      </p>

      {needsEngine && status !== 'ENDED' ? (
        <p data-testid="campaign-lifecycle-engine-off">
          <strong>Kampanya motoru kapalı — etkinleştirme yapılamaz.</strong> Etkinleştir ve devam ettir, motor açılana
          kadar reddedilir. Duraklat ve sonlandır her zaman kullanılabilir.
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div className="notice notice-error" role="status" data-testid="campaign-lifecycle-error">
          <div>{state.message}</div>
          {state.errors.length > 0 ? (
            <ul className="campaign-lifecycle-refusal">
              {state.errors.map((error, index) => (
                <li key={`${error.path}-${error.code}-${index}`}>
                  <code>{error.path || 'tanım'}</code> · {error.code}: {ruleErrorMessage(error.code, error.message)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {canActivate && activateVersion ? (
        <form action={submit} className="campaign-lifecycle-form">
          <input type="hidden" name="intent" value="activate" />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input type="hidden" name="versionNumber" value={activateVersion.versionNumber} />
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={pending || needsEngine}
            data-testid="campaign-activate"
            title={needsEngine ? 'Kampanya motoru kapalı — etkinleştirme yapılamaz' : undefined}
          >
            {status === 'DRAFT' ? `Sürüm ${activateVersion.versionNumber}’i etkinleştir` : status === 'PAUSED' ? `Sürüm ${activateVersion.versionNumber} ile devam ettir` : `Sürüm ${activateVersion.versionNumber}’e geç`}
          </button>
        </form>
      ) : null}

      {status === 'ACTIVE' || status === 'PAUSED' ? (
        <form action={submit} className="campaign-lifecycle-form">
          <input type="hidden" name="campaignId" value={campaign.id} />
          <label className="field">
            <span>Gerekçe</span>
            <textarea name="reason" minLength={3} maxLength={500} required placeholder="Neden duraklatılıyor / devam ediyor / sonlandırılıyor?" data-testid="campaign-lifecycle-reason" />
          </label>
          <div className="panel-row">
            {status === 'ACTIVE' ? (
              <button className="btn btn-secondary btn-sm" type="submit" name="intent" value="pause" disabled={pending} data-testid="campaign-pause">
                Duraklat
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                type="submit"
                name="intent"
                value="resume"
                disabled={pending || needsEngine}
                data-testid="campaign-resume"
                title={needsEngine ? 'Kampanya motoru kapalı — devam ettirme yapılamaz' : undefined}
              >
                Devam ettir
              </button>
            )}
            <button className="btn btn-danger btn-sm" type="submit" name="intent" value="end" disabled={pending} data-testid="campaign-end">
              Sonlandır
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
