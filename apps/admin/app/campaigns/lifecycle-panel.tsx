'use client';

import { useActionState } from 'react';
import type { Campaign, CampaignChannelReadiness, CampaignVersionSummary } from '../../lib/api';
import { channelLabel, ruleErrorMessage } from '../../lib/campaign-rules';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { campaignLifecycleAction } from './actions';
import { versionChanges, versionFacts } from './lifecycle-proof';
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
 *
 * ADMIN-DESIGN-001 Faz 3E: the two moves that cannot be undone — "Sonlandır"
 * and "Taslağı kapat" — ask first (ConfirmDialog), with what the API will do
 * written in the dialog. The forms carry `campaignId`, never a field named
 * "id", so the dialog's `intent` cannot be shadowed away.
 *
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A: every other move asks too,
 * each with its own proof. Activating a version says which version and its
 * rule (trigger, credit, limits, budget, channel, window) from the stored
 * version — or, for a switch or a resumption with a new version, what changes
 * — and that granted lots are never taken back automatically. Resuming with a
 * new version takes a reason like a plain resume. Pause and resume are a
 * lighter question, with the reason the form already required.
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
    <section className="admin-action-panel campaign-lifecycle-panel" data-testid="campaign-lifecycle-panel" data-status={status}>
      <h2 className="section-card-title">Yaşam döngüsü</h2>
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
        <form action={submit} className="campaign-lifecycle-form" data-testid="campaign-activate-form">
          <input type="hidden" name="intent" value="activate" />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input type="hidden" name="versionNumber" value={activateVersion.versionNumber} />
          {status === 'PAUSED' ? (
            <label className="field">
              <span>Devam ettirme gerekçesi</span>
              <textarea
                name="reason"
                minLength={3}
                maxLength={500}
                required
                placeholder="Kampanya neden yeni sürümle devam ediyor?"
                data-testid="campaign-activate-reason"
              />
            </label>
          ) : null}
          {status === 'DRAFT' ? (
            <ConfirmDialog
              proof="campaign.version-activate"
              triggerLabel={`Sürüm ${activateVersion.versionNumber}’i etkinleştir`}
              triggerClassName="btn btn-primary btn-sm"
              tone="primary"
              title={`Sürüm ${activateVersion.versionNumber} etkinleştirilsin mi?`}
              consequence={<VersionActivateConsequence campaign={campaign} version={activateVersion} />}
              confirmLabel="Evet, etkinleştir"
              disabled={pending || needsEngine || channelBlocked}
              testId="campaign-activate"
            />
          ) : status === 'ACTIVE' ? (
            <ConfirmDialog
              proof="campaign.version-switch"
              triggerLabel={`Sürüm ${activateVersion.versionNumber}’e geç`}
              triggerClassName="btn btn-primary btn-sm"
              tone="primary"
              title={`Sürüm ${activeVersion?.versionNumber ?? '?'} → ${activateVersion.versionNumber} geçişi yapılsın mı?`}
              consequence={<VersionSwitchConsequence campaign={campaign} from={activeVersion} to={activateVersion} />}
              confirmLabel="Evet, sürüme geç"
              disabled={pending || needsEngine || channelBlocked}
              testId="campaign-activate"
            />
          ) : (
            <ConfirmDialog
              proof="campaign.version-resume"
              triggerLabel={`Sürüm ${activateVersion.versionNumber} ile devam ettir`}
              triggerClassName="btn btn-primary btn-sm"
              tone="primary"
              title={`Kampanya sürüm ${activateVersion.versionNumber} ile devam ettirilsin mi?`}
              consequence={<VersionResumeConsequence campaign={campaign} from={activeVersion} to={activateVersion} />}
              confirmLabel="Evet, yeni sürümle devam ettir"
              disabled={pending || needsEngine || channelBlocked}
              testId="campaign-activate"
            />
          )}
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
            <ConfirmDialog
              proof="campaign.close-draft"
              triggerLabel="Taslağı kapat"
              triggerClassName="btn btn-destructive btn-sm"
              title="Taslak kapatılsın mı?"
              consequence={
                <>
                  <p>
                    <strong>{campaign.name}</strong> hiç etkinleşmeden kalıcı olarak <strong>Sona erdi</strong> durumuna
                    geçer ve bir daha açılamaz. Hiçbir sürümü çalıştırılmaz; hak ediş, promosyon kredisi veya olay oluşmaz.
                  </p>
                  <p>Gerekçe adınızla kampanyanın “Neler oldu” kaydına yazılır. Aynı kural için yeni bir kampanya yazmanız gerekir.</p>
                </>
              }
              confirmLabel="Evet, taslağı kapat"
              name="intent"
              value="close"
              disabled={pending}
              testId="campaign-close-draft"
            />
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
              <ConfirmDialog
                proof="campaign.pause"
                triggerLabel="Duraklat"
                triggerClassName="btn btn-secondary btn-sm"
                tone="primary"
                title="Kampanya duraklatılsın mı?"
                consequence={
                  <>
                    <p>
                      <strong>{campaign.name}</strong> <strong>Duraklatıldı</strong> olur: bundan sonraki olaylarda
                      promosyon kredisi verilmez. Duraklatılmışken olan olaylar için devam ettirildiğinde de geriye dönük
                      hak ediş üretilmez.
                    </p>
                    <p>
                      Verilmiş promosyon lotları geri alınmaz, çalışmaya devam eder. Gerekçe adınızla “Neler oldu” kaydına
                      yazılır; kampanya gerekçeyle yeniden devam ettirilebilir.
                    </p>
                  </>
                }
                confirmLabel="Evet, duraklat"
                name="intent"
                value="pause"
                disabled={pending}
                testId="campaign-pause"
              />
            ) : (
              <ConfirmDialog
                proof="campaign.resume"
                triggerLabel="Devam ettir"
                triggerClassName="btn btn-primary btn-sm"
                tone="primary"
                title="Kampanya devam ettirilsin mi?"
                consequence={
                  <>
                    <p>
                      <strong>{campaign.name}</strong> <strong>Duraklatıldı → Etkin</strong> olur ve sürüm{' '}
                      {activeVersion?.versionNumber ?? '?'} kuralıyla bundan sonraki gerçek olaylarda promosyon kredisi
                      dağıtmaya yeniden başlar. Duraklatılmışken olan olaylar için geriye dönük hak ediş üretilmez.
                    </p>
                    <p>Etkinleştirme koşulları şimdi yeniden denetlenir; tutmuyorsa API reddeder ve hiçbir şey yazılmaz. Gerekçe adınızla kayda geçer.</p>
                  </>
                }
                confirmLabel="Evet, devam ettir"
                name="intent"
                value="resume"
                disabled={pending || needsEngine}
                testId="campaign-resume"
              />
            )}
            <ConfirmDialog
              proof="campaign.end"
              triggerLabel="Sonlandır"
              triggerClassName="btn btn-destructive btn-sm"
              title="Kampanya sonlandırılsın mı?"
              consequence={
                <>
                  <p>
                    <strong>{campaign.name}</strong> kalıcı olarak <strong>Sona erdi</strong> olur ve bir daha açılamaz,
                    devam ettirilemez ya da yeni sürümle etkinleştirilemez. Bundan sonraki olaylarda hak ediş üretilmez.
                  </p>
                  <p>
                    Verilmiş promosyon lotları etkilenmez: hizmet verenler kalan kredilerini son kullanma tarihine kadar
                    kullanabilir. Gerekçe adınızla kampanyanın “Neler oldu” kaydına yazılır.
                  </p>
                </>
              }
              confirmLabel="Evet, sonlandır"
              name="intent"
              value="end"
              disabled={pending}
              testId="campaign-end"
            />
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** The version's rule, line by line, from the stored version. */
function VersionFactList({ version }: { version: CampaignVersionSummary }) {
  return (
    <dl className="confirm-dialog-facts" data-testid="campaign-version-facts">
      {versionFacts(version).map((fact) => (
        <div key={fact.key}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What changes from the running version to the next one; every line when there is no running one. */
function VersionChangeList({ from, to }: { from: CampaignVersionSummary | null; to: CampaignVersionSummary }) {
  if (!from) return <VersionFactList version={to} />;
  const changes = versionChanges(from, to);
  if (changes.length === 0) {
    return <p data-testid="campaign-version-changes">Kritik alanlarda (kredi, limit, bütçe, kanal, süre, tetikleyici) fark yok.</p>;
  }
  return (
    <dl className="confirm-dialog-facts" data-testid="campaign-version-changes">
      {changes.map((change) => (
        <div key={change.key}>
          <dt>{change.label}</dt>
          <dd>
            {change.from} → <strong>{change.to}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const LOTS_STAY =
  'Verilen promosyon lotları kampanya duraklatılsa, sonlandırılsa ya da sürüm değişse de otomatik geri alınmaz; yalnız ödeme iadesi ya da tek tek geri alma ile geri alınır.';

function VersionActivateConsequence({ campaign, version }: { campaign: Campaign; version: CampaignVersionSummary }) {
  return (
    <>
      <p>
        <strong>{campaign.name}</strong> taslaktan <strong>Etkin</strong> olur; motor sürüm {version.versionNumber}{' '}
        kuralını değerlendirmeye başlar:
      </p>
      <VersionFactList version={version} />
      <p>
        Etkinleşince bundan sonraki gerçek olaylarda (onay, kanıt, ödeme) koşulları sağlayan hizmet verenlere{' '}
        <strong>promosyon kredisi dağıtımı başlar</strong>. Geçmiş olaylar için hak ediş üretilmez.
      </p>
      <p>{LOTS_STAY} Etkinleştirme adınızla “Neler oldu” kaydına yazılır.</p>
    </>
  );
}

function VersionSwitchConsequence({
  campaign,
  from,
  to,
}: {
  campaign: Campaign;
  from: CampaignVersionSummary | null;
  to: CampaignVersionSummary;
}) {
  return (
    <>
      <p>
        <strong>{campaign.name}</strong> etkin kalır; çalışan kural sürüm {from?.versionNumber ?? '?'} yerine{' '}
        <strong>sürüm {to.versionNumber}</strong> olur. Değişen kritik alanlar:
      </p>
      <VersionChangeList from={from} to={to} />
      <p>
        Yeni kural <strong>onaydan hemen sonra</strong>, bir sonraki olaydan itibaren uygulanır. Kullanılmış hak ediş ve
        bütçe sayaçları sıfırlanmaz.
      </p>
      <p>{LOTS_STAY}</p>
    </>
  );
}

function VersionResumeConsequence({
  campaign,
  from,
  to,
}: {
  campaign: Campaign;
  from: CampaignVersionSummary | null;
  to: CampaignVersionSummary;
}) {
  return (
    <>
      <p>
        <strong>{campaign.name}</strong> <strong>Duraklatıldı → Etkin</strong> olur ve sürüm {from?.versionNumber ?? '?'}{' '}
        yerine <strong>sürüm {to.versionNumber}</strong> kuralıyla devam eder. Değişen kritik alanlar:
      </p>
      <VersionChangeList from={from} to={to} />
      <p>
        Onaydan sonraki gerçek olaylarda <strong>promosyon kredisi dağıtımı yeniden başlar</strong>. Duraklatılmışken
        olan olaylar için geriye dönük hak ediş üretilmez. Gerekçe adınızla kayda geçer.
      </p>
      <p>{LOTS_STAY}</p>
    </>
  );
}
