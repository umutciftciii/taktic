import Link from 'next/link';
import {
  apiFetch,
  CampaignEngineSettings,
  formatDateTime,
  MarketplacePublishSettings,
  OPERATIONS_SETTING_LABELS,
  OperationsSettings,
  ProviderReviewSettings,
  requireAdmin,
  SCHEDULER_JOB_COPY,
  SchedulerSettings,
} from '../../lib/api';
import { InfoPopover } from '../../components/info-popover';
import { PageHeader } from '../../components/page-header';
import { saveOperationsSettingsAction } from './actions';
import { AutoPublishToggle } from './auto-publish-toggle';
import { CampaignEngineToggle } from './campaign-engine-toggle';
import { ProviderReviewsToggle } from './provider-reviews-toggle';
import { SchedulerToggle } from './scheduler-toggle';
import { AuditTable, SettingRow, SettingsGroup, switchStateLabel } from './setting-row';

/**
 * The commercial terms an operator maintains, starting with the one this
 * platform makes to every provider: how long a customer has to open an offer
 * before the provider's credit comes back.
 *
 * The two things this screen is careful about are both about time.
 *
 * It changes the *next* offer, never one that exists. Every offer snapshots the
 * window it was sold under when it is created, and the refund worker reads that
 * snapshot — so an offer sold at 48 hours keeps 48 hours after this value moves
 * to 72, and moving it to 12 cannot pay one out early. The panel says so, in
 * those words, because an operator who believes otherwise would use this screen
 * to try to fix a past case.
 *
 * And it records who changed it. The audit list below is the platform's answer
 * to "what was the window on the third, and who set it?" — a question a
 * settings row that overwrites itself cannot answer.
 *
 * ADMIN-DESIGN-001 Faz 3E (design `settings`, K5): only the settings that
 * exist are drawn — the refund window, auto-publish, reviews, the campaign
 * engine and the scheduled jobs the API lists — each as the design's row with
 * a state badge, what it does and a "ne olur" disclosure. The design's other
 * rows (request lifetime, reminder day, offer price, offer cap, re-offer) are
 * not settings in this product and are not drawn. Every row still saves on
 * its own, behind the permission its own route asks for; there is no shared
 * "save changes" bar. The five change lists moved together under "Neler
 * oldu", each unchanged. Opening a job and moving the engine now ask first.
 */

export const dynamic = 'force-dynamic';

type OperationsSettingsPageProps = {
  searchParams: Promise<{
    error?: string;
    ok?: string;
    unviewedOfferRefundWindowHours?: string;
  }>;
};

const OK_MESSAGES: Record<string, string> = {
  saved:
    'Operasyon ayarları kaydedildi. Yeni süre yalnızca bundan sonra oluşturulan teklifler için geçerlidir.',
  'scheduler-on':
    'Zamanlanmış iş açıldı. İş, kendi cron zamanındaki ilk çalışmasından itibaren devreye girer.',
  'scheduler-off':
    'Zamanlanmış iş kapatıldı. Sıradaki cron çalışması hiçbir işlem yapmaz; sunucu yeniden başlatmaya gerek yoktur.',
  'auto-publish-on':
    'Otomatik yayın açıldı. Bundan sonra gönderilen pazar talepleri moderasyon beklemeden eşleşen hizmet verenlere iletilir.',
  'auto-publish-off':
    'Otomatik yayın kapatıldı. Bundan sonra gönderilen pazar talepleri onay kuyruğuna düşer; yayındaki talepler geri çekilmez.',
  'provider-reviews-on':
    'Hizmet veren değerlendirmeleri açıldı. Bundan sonra tamamlanan işlerde müşteriye değerlendirme daveti gider; mevcut değerlendirmeler public profil ve teklif kartlarında görünür.',
  'provider-reviews-off':
    'Hizmet veren değerlendirmeleri kapatıldı. Müşteri değerlendirme yazamaz, davet gönderilmez; mevcut değerlendirmeler silinmez, yalnız gizlenir.',
  'campaign-engine-on':
    'Kampanya motoru açıldı. Bundan sonraki gerçek olaylar (onay, kanıt, ödeme) kaydedilir ve aktif kampanyalar promosyon kredisi verebilir; geçmiş olaylar için hak ediş üretilmez.',
  'campaign-engine-off':
    'Kampanya motoru kapatıldı. Yeni olay kaydedilmez ve değerlendirilmez; verilmiş promosyonların iadesi ve geri alınması aynen sürer.',
};

const RUN_OUTCOME_LABELS: Record<string, string> = {
  SUCCESS: 'Tamamlandı',
  FAILED: 'Hata',
  SKIPPED: 'Atlandı',
};

export default async function OperationsSettingsPage({
  searchParams,
}: OperationsSettingsPageProps) {
  const { can } = await requireAdmin('OPERATIONS_SETTINGS_READ');

  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  const okMessage = params.ok ? (OK_MESSAGES[params.ok] ?? null) : null;

  const [settings, schedulers, publish, reviews, engine] = await Promise.all([
    apiFetch<OperationsSettings>('/operations-settings'),
    apiFetch<SchedulerSettings>('/operations-settings/schedulers'),
    apiFetch<MarketplacePublishSettings>('/operations-settings/marketplace-publish'),
    apiFetch<ProviderReviewSettings>('/operations-settings/provider-reviews'),
    apiFetch<CampaignEngineSettings>('/operations-settings/campaign-engine'),
  ]);

  /*
   * The engine toggle is its own permission (RG-7 §12.4), not part of the
   * operations write this page otherwise asks for: every other switch here is a
   * working preference, and this one starts promotional credit flowing. A role
   * trusted with the rest is not thereby trusted with this, so the card renders
   * read-only without it and the button is not on the page at all — the server
   * action would be refused anyway, and a button that cannot work is a worse
   * answer than an explanation.
   */
  const canToggleEngine = can('CAMPAIGN_ENGINE_TOGGLE');
  // Each switch is gated by the permission its own PUT route asks for
  // (route-permission-map.ts); without it the card keeps its Açık/Kapalı pill
  // and history, and the control is simply not rendered.
  const canWriteSettings = can('OPERATIONS_SETTINGS_WRITE');
  const canToggleSchedulers = can('SCHEDULERS_WRITE');
  const canToggleAutoPublish = can('MARKETPLACE_PUBLISH_WRITE');
  const canToggleProviderReviews = can('PROVIDER_REVIEWS_SETTING_WRITE');

  // A rejected save carries the operator's own value back in the query, so the
  // form re-hydrates with what they typed rather than with what is stored.
  const windowHours =
    params.unviewedOfferRefundWindowHours ??
    String(settings.unviewedOfferRefundWindowHours);

  const stateBadge = (enabled: boolean, testId: string) => (
    <span className={enabled ? 'badge badge-good' : 'badge badge-muted'} data-testid={testId}>
      {enabled ? 'Açık' : 'Kapalı'}
    </span>
  );
  const defaultOff = (value: string | null) =>
    value === null ? <span className="muted">varsayılan (kapalı)</span> : switchStateLabel(value);

  return (
    <main className="operations-settings-page">
      <PageHeader
        title="Operasyon ayarları"
        subtitle="Her ayar platformun kendi başına yaptığı bir işi açar, kapatır ya da ayarlar. Her satırın altında ne olacağı yazar; değişiklik kaydedildiği anda geçerli olur ve adınızla kayda geçer."
        info={
          <>
            Her ayar kendi formuyla, kendi izniyle ve tek tek kaydedilir; toplu kaydetme yoktur. Görmeye yetkiniz olup
            değiştirmeye yetkiniz olmayan bir ayarın yalnız durumu ve geçmişi görünür. Kredi miktarları, teklif sınırı ve
            talep süreleri bu ekranda ayar değildir.
          </>
        }
      />

      {errorMessage ? (
        <div className="notice notice-error settings-notice" role="alert" data-testid="operations-settings-error">
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success settings-notice" role="status" data-testid="operations-settings-ok">
          {okMessage}
        </div>
      ) : null}

      <div className="settings-stack">
        <SettingsGroup
          id="talep-akisi"
          title="Talep akışı"
          subtitle="Müşteriden gelen bir talebin hizmet verenlere ne zaman görüneceğini belirler."
        >
          <SettingRow
            id="otomatik-yayin"
            testId="auto-publish"
            name="Pazar talepleri otomatik yayınlansın"
            badge={stateBadge(publish.enabled, 'auto-publish-state')}
            description="Açıkken yeni talepler moderasyon beklemeden eşleşen hizmet verenlere iletilir; kapalıyken bugünkü onay akışı sürer."
            whatHappens={{
              question: publish.enabled ? 'Kapatırsam ne olur?' : 'Açarsam ne olur?',
              answer: (
                <p>
                  Yalnız bundan sonra gönderilen talepleri etkiler: onay bekleyen bir talep kuyruğunda kalır, yayındaki
                  bir talep geri çekilmez. Telefonu doğrulanmamış bir talep açıkken de yayınlanmaz. Hizmet verenler
                  yayındaki bir talebi bildirebilir; bildirimler{' '}
                  {can('REQUEST_REPORTS_READ') ? (
                    <Link href="/requests/reports">Talep bildirimleri</Link>
                  ) : (
                    'Talep bildirimleri'
                  )}{' '}
                  kuyruğuna düşer.
                </p>
              ),
            }}
            control={canToggleAutoPublish ? <AutoPublishToggle enabled={publish.enabled} /> : null}
          />
        </SettingsGroup>

        <SettingsGroup
          id="teklif-kredisi"
          title="Teklif kredisi"
          subtitle="Teklif veren hizmet verenin kredisinin ne zaman kendiliğinden geri döneceğini belirler."
        >
          <SettingRow
            id="kredi-iadesi"
            testId="refund-window"
            name="Görüntülenmeyen teklif için kredi iade süresi"
            badge={
              <span className="badge badge-muted" data-testid="refund-window-state">
                {settings.unviewedOfferRefundWindowHours} saat
              </span>
            }
            description="Müşteri teklifi bu süre içinde görüntülemezse teklif kredisi otomatik olarak hizmet verene iade edilir."
            meta={
              <>
                <span>
                  {settings.configured
                    ? 'Kayıtlı'
                    : `Varsayılan (${settings.defaultUnviewedOfferRefundWindowHours} saat)`}
                </span>
                {settings.updatedAt ? <span>güncellenme {formatDateTime(settings.updatedAt)}</span> : null}
                {settings.updatedBy?.name ? <span>son düzenleyen {settings.updatedBy.name}</span> : null}
              </>
            }
            whatHappens={{
              question: 'Değiştirirsem ne olur?',
              answer: (
                <p>
                  Yalnız yeni teklifleri etkiler. Her teklif, oluşturulduğu andaki iade süresini ve kesin iade zamanını
                  kendi üzerinde saklar; iade işçisi bu kaydı okur, güncel ayarı değil. Bugün{' '}
                  {settings.defaultUnviewedOfferRefundWindowHours} saatle oluşturulmuş bir teklif, yarın bu ayar değişse
                  bile kendi süresini korur.
                </p>
              ),
            }}
            control={
              canWriteSettings ? (
                <form action={saveOperationsSettingsAction} className="setting-number-form" data-testid="operations-settings-form">
                  <label className="setting-number-field" htmlFor="refund-window-hours">
                    <span className="sr-only">Görüntülenmeyen teklif için kredi iade süresi (saat)</span>
                    <input
                      id="refund-window-hours"
                      name="unviewedOfferRefundWindowHours"
                      type="number"
                      required
                      step={1}
                      min={settings.minUnviewedOfferRefundWindowHours}
                      max={settings.maxUnviewedOfferRefundWindowHours}
                      defaultValue={windowHours}
                    />
                    <span className="setting-number-unit" aria-hidden="true">
                      saat
                    </span>
                  </label>
                  <button className="btn btn-primary btn-sm" type="submit">
                    Kaydet
                  </button>
                </form>
              ) : null
            }
          >
            {canWriteSettings ? (
              <p className="detail-muted-note">
                Yalnız tam saat girilebilir. En az {settings.minUnviewedOfferRefundWindowHours}, en fazla{' '}
                {settings.maxUnviewedOfferRefundWindowHours} saat. Varsayılan {settings.defaultUnviewedOfferRefundWindowHours}{' '}
                saattir.
              </p>
            ) : (
              <dl className="setting-readonly" data-testid="operations-settings-readonly">
                <div>
                  <dt>Görüntülenmeyen teklif için kredi iade süresi</dt>
                  <dd>{settings.unviewedOfferRefundWindowHours} saat</dd>
                </div>
                <div>
                  <dt>İzin verilen aralık</dt>
                  <dd>
                    {settings.minUnviewedOfferRefundWindowHours}–{settings.maxUnviewedOfferRefundWindowHours} saat
                    (varsayılan {settings.defaultUnviewedOfferRefundWindowHours})
                  </dd>
                </div>
              </dl>
            )}
            <div className="setting-quote">
              <p className="setting-quote-label">Hizmet verene gösterilen metin</p>
              <p className="setting-quote-text" data-testid="operations-settings-notice">
                {settings.unviewedOfferRefundNotice}
              </p>
            </div>
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          id="degerlendirme-ve-kampanyalar"
          title="Değerlendirme ve kampanyalar"
          subtitle="Müşteri değerlendirmelerinin ve otomatik kampanyaların çalışıp çalışmayacağı."
        >
          <SettingRow
            id="degerlendirmeler"
            testId="provider-reviews"
            name="Hizmet veren değerlendirmeleri"
            badge={stateBadge(reviews.enabled, 'provider-reviews-state')}
            description="Açıkken müşteri, tamamlanan işin hizmet verenini değerlendirebilir; public profil ve teklif kartlarında ortalama görünür. Kapalıyken mevcut değerlendirmeler silinmez, yalnız gizlenir."
            whatHappens={{
              question: reviews.enabled ? 'Kapatırsam ne olur?' : 'Açarsam ne olur?',
              answer: (
                <p>
                  Açıkken iş tamamlandığında müşteriye değerlendirme daveti gider ve değerlendirme geldiğinde hizmet
                  verene haber verilir. Ortalama puan, en az üç değerlendirmesi olan hizmet verenler için gösterilir.
                  Hizmet verenler uygunsuz bir yorumu bildirebilir; bildirimler{' '}
                  {can('PROVIDER_REVIEWS_READ') ? (
                    <Link href="/provider-reviews/reports">Değerlendirme bildirimleri</Link>
                  ) : (
                    'Değerlendirme bildirimleri'
                  )}{' '}
                  kuyruğuna düşer. Puanlar kredi, teklif sıralaması, paket ya da vitrin hakkını etkilemez. Kapalıyken
                  müşteri değerlendirme yazamaz ve davet gönderilmez.
                </p>
              ),
            }}
            control={canToggleProviderReviews ? <ProviderReviewsToggle enabled={reviews.enabled} /> : null}
          />

          {/*
            The campaign engine (CMP-004 S4). Off by default and read
            fail-closed by every engine path; this is its only writer. Unlike
            the switches above it asks before it moves, because it is the one
            that starts promotional credit being granted.
          */}
          <SettingRow
            id="kampanya-motoru"
            testId="campaign-engine"
            name="Kampanya motoru çalışsın"
            badge={stateBadge(engine.enabled, 'campaign-engine-state')}
            description="Açıkken etkin kampanyalar gerçek olaylarda (onay, kanıt, ödeme) promosyon kredisi verir; kapalıyken hiçbir olay kaydedilmez ve değerlendirilmez."
            whatHappens={{
              question: engine.enabled ? 'Kapatırsam ne olur?' : 'Açarsam ne olur?',
              answer: (
                <p>
                  <strong>Açmak</strong> yalnız bundan sonraki olayları etkiler: motor kapalıyken olmuş bir onay, kanıt ya
                  da ödeme için geriye dönük hak ediş üretilmez. Aktif kampanya yoksa motor açık olsa da kimseye kredi
                  verilmez. <strong>Kapatmak</strong> yeni olay kaydını ve değerlendirmeyi durdurur; verilmiş
                  promosyonların teklif iadesi ve ödeme iadesinde geri alınması aynen sürer. Kampanyalar{' '}
                  {can('CAMPAIGNS_READ') ? <Link href="/campaigns">Kampanyalar</Link> : 'Kampanyalar'} ekranından
                  yönetilir.
                </p>
              ),
            }}
            control={canToggleEngine ? <CampaignEngineToggle enabled={engine.enabled} /> : null}
          >
            {canToggleEngine ? null : (
              <p className="detail-muted-note" data-testid="campaign-engine-toggle-forbidden">
                Motoru açma/kapama yetkiniz yok. Bu, operasyon ayarlarını düzenleme yetkisinden ayrı tutulan tek
                anahtardır; promosyon kredisi dağıtımını başlatan karar olduğu için ayrı bir izne bağlıdır.
              </p>
            )}
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          id="zamanlanmis-isler"
          title="Zamanlanmış İşler"
          subtitle="Arka plan işlerinin açık/kapalı durumu. Cron zamanları dağıtım ayarıdır ve buradan değiştirilemez."
          info={
            <InfoPopover label="Zamanlanmış işler nasıl çalışır?" size="sm">
              Her iş kendi cron zamanında uyanır ve o anda bu ayarı okur. Açtığınız bir iş sıradaki cron çalışmasında
              devreye girer, kapattığınız iş sıradaki çalışmada hiçbir şey yapmaz; sunucuyu yeniden başlatmanız gerekmez.
              Ayar okunamazsa iş kapalı kabul edilir. Elle çalıştırma düğmesi bilinçli olarak yoktur. Son çalışma bilgisi
              bu API sunucusunun belleğinde tutulur: yeniden başlatmada sıfırlanır ve birden fazla sunucu varsa her biri
              kendi çalışmasını gösterir.
            </InfoPopover>
          }
        >
          <ul className="settings-row-list" data-testid="scheduler-list">
            {schedulers.jobs.map((job) => {
              const copy = SCHEDULER_JOB_COPY[job.key];
              return (
                <SettingRow
                  key={job.key}
                  as="li"
                  testId={`scheduler-${job.key}`}
                  name={copy.name}
                  badge={stateBadge(job.enabled, `scheduler-state-${job.key}`)}
                  description={copy.impact}
                  meta={
                    <>
                      <span>
                        cron <code>{job.cron}</code>
                      </span>
                      {job.lastRun ? (
                        <span>
                          son çalışma {formatDateTime(job.lastRun.finishedAt)} ·{' '}
                          {RUN_OUTCOME_LABELS[job.lastRun.outcome] ?? job.lastRun.outcome}
                          {job.lastRun.summary ? ` · ${job.lastRun.summary}` : ''}
                        </span>
                      ) : (
                        <span>bu sunucuda çalışmadı</span>
                      )}
                    </>
                  }
                  // Shown before the switch is used, not after: an operator
                  // deciding whether to flip a money job needs to read what it
                  // will start while the switch is still off.
                  warning={copy.confirmation}
                  whatHappens={{
                    question: job.enabled ? 'Kapatırsam ne olur?' : 'Açarsam ne olur?',
                    answer: job.enabled ? (
                      <p>Sıradaki cron çalışması hiçbir işlem yapmaz; sunucuyu yeniden başlatmaya gerek yoktur.</p>
                    ) : (
                      <p>İş, kendi cron zamanındaki ilk çalışmasından itibaren devreye girer.</p>
                    ),
                  }}
                  control={
                    canToggleSchedulers ? (
                      <SchedulerToggle
                        job={job.key}
                        jobName={copy.name}
                        enabled={job.enabled}
                        consequence={
                          <>
                            <p>{copy.impact}</p>
                            {copy.confirmation ? <p>{copy.confirmation}</p> : null}
                            <p>
                              İş, kendi cron zamanındaki (<code>{job.cron}</code>) ilk çalışmasından itibaren devreye girer.
                              Değişiklik adınızla kayda geçer
                              {copy.disableConfirmation ? '.' : '; kapatmak onay istemez.'}
                            </p>
                          </>
                        }
                        disableConsequence={
                          copy.disableConfirmation ? (
                            <>
                              <p>{copy.disableConfirmation}</p>
                              <p>
                                Sıradaki cron çalışmasından (<code>{job.cron}</code>) itibaren geçerlidir; sunucuyu yeniden
                                başlatmaya gerek yoktur. Değişiklik adınızla kayda geçer.
                              </p>
                            </>
                          ) : undefined
                        }
                      />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        </SettingsGroup>

        <SettingsGroup
          id="neler-oldu"
          title="Neler oldu"
          subtitle="Her değişiklikte eski değer, yeni değer, işlemi yapan yönetici ve zaman kaydedilir. Her ayarın geçmişi ayrı tutulur."
        >
          <div className="settings-audit-list">
            <AuditTable
              title="Kredi iade süresi"
              caption="Kredi iade süresi değişiklikleri"
              changes={settings.recentChanges}
              testId="operations-settings-audit"
              emptyText="Henüz bir değişiklik kaydı yok."
              settingLabel={(setting) => OPERATIONS_SETTING_LABELS[setting] ?? setting}
              formatValue={(value) => value}
              formatPrevious={(value) =>
                value ?? <span className="muted">varsayılan ({settings.defaultUnviewedOfferRefundWindowHours})</span>
              }
            />
            <AuditTable
              title="Otomatik yayın"
              caption="Otomatik yayın değişiklikleri"
              changes={publish.recentChanges}
              testId="auto-publish-audit"
              emptyText="Henüz bir değişiklik kaydı yok; ayar varsayılan (kapalı) durumda."
              emptyTestId="auto-publish-audit-empty"
              formatValue={switchStateLabel}
              formatPrevious={defaultOff}
            />
            <AuditTable
              title="Hizmet veren değerlendirmeleri"
              caption="Değerlendirme ayarı değişiklikleri"
              changes={reviews.recentChanges}
              testId="provider-reviews-audit"
              emptyText="Henüz bir değişiklik kaydı yok; ayar varsayılan (kapalı) durumda."
              emptyTestId="provider-reviews-audit-empty"
              formatValue={switchStateLabel}
              formatPrevious={defaultOff}
            />
            <AuditTable
              title="Kampanya motoru"
              caption="Kampanya motoru değişiklikleri"
              changes={engine.recentChanges}
              testId="campaign-engine-audit"
              emptyText="Henüz bir değişiklik kaydı yok; motor varsayılan (kapalı) durumda."
              emptyTestId="campaign-engine-audit-empty"
              formatValue={switchStateLabel}
              formatPrevious={defaultOff}
            />
            <AuditTable
              title="Zamanlanmış işler"
              caption="Zamanlanmış iş değişiklikleri"
              changes={schedulers.recentChanges}
              testId="scheduler-audit"
              emptyText="Henüz bir değişiklik kaydı yok."
              emptyTestId="scheduler-audit-empty"
              settingLabel={(setting) => OPERATIONS_SETTING_LABELS[setting] ?? setting}
              formatValue={switchStateLabel}
              formatPrevious={defaultOff}
            />
          </div>
        </SettingsGroup>
      </div>
    </main>
  );
}
