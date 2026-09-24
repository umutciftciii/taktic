'use client';

import { useActionState } from 'react';
import type { Campaign, CampaignChannelReadiness, CampaignVersionSummary } from '../../lib/api';
import { channelLabel, ruleErrorMessage } from '../../lib/campaign-rules';
import { campaignLifecycleAction } from './actions';
import { IDLE_CAMPAIGN_LIFECYCLE_STATE } from './lifecycle-state';

type CampaignLifecyclePanelProps = {
  campaign: Campaign;
  engineEnabled: boolean;
  activeVersion: CampaignVersionSummary | null;
  currentVersion: CampaignVersionSummary | null;
  /** CMP-006 PR-D: the API's answer for the version "activate" would activate. */
  currentVersionChannel: CampaignChannelReadiness | null;
  /**
   * CAMPAIGNS_LIFECYCLE — decided on the server. Without it the panel still
   * says what state the campaign is in, but offers no move.
   */
  canLifecycle: boolean;
};

/**
 * The lifecycle desk of one campaign (CMP-002 S2B2).
 *
 * Exactly the moves the API allows are offered: a DRAFT can be activated or
 * closed (BUG-OPS-002: "Taslağı kapat" — the `end` route, worded as what it
 * is for a campaign that never ran, and never gated on the engine or the
 * channel), an ACTIVE campaign paused or ended (and a newer version activated in place of
 * the running one), a PAUSED campaign resumed or ended, an ENDED campaign
 * nothing. Activation and resumption are shown disabled — with the sentence
 * that explains why — while the engine switch is off, because the API would
 * refuse them with CAMPAIGN_ENGINE_DISABLED and a screen must not offer an
 * action it knows will come back as an error. Pause and end never need the
 * engine. Nothing here can turn the engine on.
 *
 * The same holds for the channel (CMP-006 PR-D): when the API reports that
 * no registered source produces the stored version's channel — MOBILE today —
 * the panel says so and disables activation; the API's
 * CHANNEL_SOURCE_UNAVAILABLE is the authority, and a forced submission shows
 * its refusal.
 */
export function CampaignLifecyclePanel({
  campaign,
  engineEnabled,
  activeVersion,
  currentVersion,
  currentVersionChannel,
  canLifecycle,
}: CampaignLifecyclePanelProps) {
  const [state, submit, pending] = useActionState(campaignLifecycleAction, IDLE_CAMPAIGN_LIFECYCLE_STATE);
  const status = campaign.status;
  // Offer "activate version N" only where it does something a plain resume
  // does not: a first activation, or a swap to a newer stored version.
  const newerVersionStored = currentVersion !== null && currentVersion.id !== activeVersion?.id;
  const canActivate =
    canLifecycle && (status === 'DRAFT' || ((status === 'ACTIVE' || status === 'PAUSED') && newerVersionStored));
  const activateVersion = currentVersion;
  const needsEngine = !engineEnabled;
  const channelBlocked = canActivate && currentVersionChannel !== null && !currentVersionChannel.available;

  return (
    <div className="admin-action-panel" data-testid="campaign-lifecycle-panel" data-status={status}>
      <h3>Yaşam döngüsü</h3>
      <p>
        {status === 'DRAFT' && 'Taslak: motor açıkken bir sürüm etkinleştirilerek ACTIVE olur. Kullanılmayacaksa kapatılabilir.'}
        {status === 'ACTIVE' && `Etkin — motor sürüm ${activeVersion?.versionNumber ?? '?'} kuralını değerlendiriyor. Kural yerinde değiştirilemez; yeni revizyon kaydedip etkinleştirin.`}
        {status === 'PAUSED' && 'Duraklatıldı: yeni hak ediş üretilmez, mevcut promosyon lotları çalışmaya devam eder.'}
        {status === 'ENDED' &&
          (campaign.activeVersionId === null
            ? 'Taslak kapatıldı: kampanya hiç etkinleşmedi ve bir daha açılamaz.'
            : 'Sona erdi: bu kampanya bir daha açılamaz; mevcut lotlar etkilenmez.')}
      </p>

      {canLifecycle && needsEngine && status !== 'ENDED' ? (
        <p data-testid="campaign-lifecycle-engine-off">
          <strong>Kampanya motoru kapalı — etkinleştirme yapılamaz.</strong> Etkinleştir ve devam ettir, motor açılana
          kadar reddedilir. {status === 'DRAFT' ? 'Taslağı kapatmak' : 'Duraklat ve sonlandır'} her zaman kullanılabilir.
        </p>
      ) : null}

      {channelBlocked && currentVersionChannel ? (
        <p className="notice notice-warning" data-testid="campaign-lifecycle-channel-unavailable" data-channel={currentVersionChannel.channel}>
          <strong>
            {channelLabel(currentVersionChannel.channel)} kanalı için kayıtlı kaynak yok — sürüm {activateVersion?.versionNumber} etkinleştirilemez.
          </strong>{' '}
          Bu kanaldan olay üreten bir kaynak ({currentVersionChannel.missingSources.join(', ')}) kayıtlı olmadığından sürüm hiçbir
          hak ediş üretemez. Kanalı Web veya Tümü olan yeni bir revizyon kaydedin.
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
            disabled={pending || needsEngine || channelBlocked}
            data-testid="campaign-activate"
            title={
              needsEngine
                ? 'Kampanya motoru kapalı — etkinleştirme yapılamaz'
                : channelBlocked
                  ? 'Bu kanal için kayıtlı kaynak yok — etkinleştirme yapılamaz'
                  : undefined
            }
          >
            {status === 'DRAFT' ? `Sürüm ${activateVersion.versionNumber}’i etkinleştir` : status === 'PAUSED' ? `Sürüm ${activateVersion.versionNumber} ile devam ettir` : `Sürüm ${activateVersion.versionNumber}’e geç`}
          </button>
        </form>
      ) : null}

      {canLifecycle && status === 'DRAFT' ? (
        <form action={submit} className="campaign-lifecycle-form" data-testid="campaign-close-draft-form">
          <input type="hidden" name="campaignId" value={campaign.id} />
          <p>
            Taslağı kapatmak kampanyayı hiç etkinleştirmeden kalıcı olarak <strong>Sona erdi</strong> durumuna alır. Hiçbir sürüm
            çalıştırılmaz; hak ediş, promosyon kredisi veya olay oluşmaz.
          </p>
          <label className="field">
            <span>Gerekçe</span>
            <textarea name="reason" minLength={3} maxLength={500} required placeholder="Taslak neden kapatılıyor?" data-testid="campaign-close-draft-reason" />
          </label>
          <div className="panel-row">
            <button className="btn btn-danger btn-sm" type="submit" name="intent" value="close" disabled={pending} data-testid="campaign-close-draft">
              Taslağı kapat
            </button>
          </div>
        </form>
      ) : null}

      {canLifecycle && (status === 'ACTIVE' || status === 'PAUSED') ? (
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
