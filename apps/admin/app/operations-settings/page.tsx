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
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { saveOperationsSettingsAction } from './actions';
import { AutoPublishToggle } from './auto-publish-toggle';
import { CampaignEngineToggle } from './campaign-engine-toggle';
import { ProviderReviewsToggle } from './provider-reviews-toggle';
import { SchedulerToggle } from './scheduler-toggle';

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

  return (
    <main className="operations-settings-page">
      <PageHeader
        breadcrumbs={[{ label: 'Yönetim' }, { label: 'Operasyon Ayarları' }]}
        title="Operasyon Ayarları"
        subtitle="Hizmet verenlere verilen ticari sözlerin yönetildiği yer."
      />

      {errorMessage ? (
        <div
          className="notice notice-error"
          role="alert"
          data-testid="operations-settings-error"
          style={{ marginBottom: 12 }}
        >
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }}>
          {okMessage}
        </div>
      ) : null}

      <div className="admin-meta-pills">
        <span
          className={settings.configured ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
        >
          {settings.configured
            ? 'Kayıtlı'
            : `Varsayılan (${settings.defaultUnviewedOfferRefundWindowHours} saat)`}
        </span>
        {settings.updatedAt ? (
          <span className="meta-pill">güncellenme {formatDateTime(settings.updatedAt)}</span>
        ) : null}
        {settings.updatedBy?.name ? (
          <span className="meta-pill">son düzenleyen {settings.updatedBy.name}</span>
        ) : null}
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Kredi iadesi"
            subtitle="Müşteri teklifi bu süre içinde görüntülemezse teklif kredisi otomatik olarak hizmet verene iade edilir."
          >
            {canWriteSettings ? (
            <form
              action={saveOperationsSettingsAction}
              className="compact-form"
              data-testid="operations-settings-form"
            >
              <div className="compact-field-grid">
                <label className="field field-12">
                  <span>Görüntülenmeyen teklif için kredi iade süresi (saat) *</span>
                  <input
                    name="unviewedOfferRefundWindowHours"
                    type="number"
                    required
                    step={1}
                    min={settings.minUnviewedOfferRefundWindowHours}
                    max={settings.maxUnviewedOfferRefundWindowHours}
                    defaultValue={windowHours}
                  />
                  <small className="muted">
                    Yalnız tam saat girilebilir. En az{' '}
                    {settings.minUnviewedOfferRefundWindowHours}, en fazla{' '}
                    {settings.maxUnviewedOfferRefundWindowHours} saat. Varsayılan{' '}
                    {settings.defaultUnviewedOfferRefundWindowHours} saattir.
                  </small>
                </label>
              </div>
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button className="btn btn-primary" type="submit">
                  Kaydet
                </button>
              </div>
            </form>
            ) : (
              <dl className="info-grid" data-testid="operations-settings-readonly">
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
          </SectionCard>

          <SectionCard
            title="Ayar değişiklikleri"
            subtitle="Her değişiklikte eski değer, yeni değer, işlemi yapan yönetici ve zaman kaydedilir."
          >
            {settings.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Henüz bir değişiklik kaydı yok.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="operations-settings-audit">
                  <thead>
                    <tr>
                      <th>Ayar</th>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>{OPERATIONS_SETTING_LABELS[change.setting] ?? change.setting}</td>
                        <td>
                          {change.previousValue ?? (
                            <span className="muted">
                              varsayılan ({settings.defaultUnviewedOfferRefundWindowHours})
                            </span>
                          )}
                        </td>
                        <td>{change.newValue}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            id="otomatik-yayin"
            title="Pazar talepleri otomatik yayınlansın"
            subtitle="Açıkken yeni talepler moderasyon beklemeden eşleşen hizmet verenlere iletilir; kapalıyken bugünkü onay akışı sürer."
          >
            <div className="scheduler-item-head" data-testid="auto-publish">
              <div className="scheduler-item-text">
                <p className="scheduler-item-impact">
                  Yalnız bundan sonra gönderilen talepleri etkiler: onay bekleyen bir talep
                  kuyruğunda kalır, yayındaki bir talep geri çekilmez. Telefonu doğrulanmamış bir
                  talep açıkken de yayınlanmaz. Hizmet verenler yayındaki bir talebi bildirebilir;
                  bildirimler{' '}
                  {can('REQUEST_REPORTS_READ') ? (
                    <Link href="/requests/reports">Talep bildirimleri</Link>
                  ) : (
                    'Talep bildirimleri'
                  )}{' '}
                  kuyruğuna düşer.
                </p>
              </div>
              {canToggleAutoPublish ? <AutoPublishToggle enabled={publish.enabled} /> : null}
            </div>
            <div className="scheduler-item-meta">
              <span
                className={publish.enabled ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
                data-testid="auto-publish-state"
              >
                {publish.enabled ? 'Açık' : 'Kapalı'}
              </span>
            </div>

            <h3 className="operations-subheading">Son değişiklikler</h3>
            {publish.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }} data-testid="auto-publish-audit-empty">
                Henüz bir değişiklik kaydı yok; ayar varsayılan (kapalı) durumda.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="auto-publish-audit">
                  <thead>
                    <tr>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {publish.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>
                          {change.previousValue === null ? (
                            <span className="muted">varsayılan (kapalı)</span>
                          ) : (
                            schedulerStateLabel(change.previousValue)
                          )}
                        </td>
                        <td>{schedulerStateLabel(change.newValue)}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            id="degerlendirmeler"
            title="Hizmet veren değerlendirmeleri"
            subtitle="Açıkken müşteri, tamamlanan işin hizmet verenini değerlendirebilir; public profil ve teklif kartlarında ortalama görünür. Kapalıyken mevcut değerlendirmeler silinmez, yalnız gizlenir."
          >
            <div className="scheduler-item-head" data-testid="provider-reviews">
              <div className="scheduler-item-text">
                <p className="scheduler-item-impact">
                  Açıkken iş tamamlandığında müşteriye değerlendirme daveti gider ve
                  değerlendirme geldiğinde hizmet verene haber verilir. Ortalama puan, en az üç
                  değerlendirmesi olan hizmet verenler için gösterilir. Hizmet verenler uygunsuz bir
                  yorumu bildirebilir; bildirimler{' '}
                  {can('PROVIDER_REVIEWS_READ') ? (
                    <Link href="/provider-reviews/reports">Değerlendirme bildirimleri</Link>
                  ) : (
                    'Değerlendirme bildirimleri'
                  )}{' '}
                  kuyruğuna
                  düşer. Puanlar kredi, teklif sıralaması, paket ya da vitrin hakkını etkilemez.
                </p>
              </div>
              {canToggleProviderReviews ? <ProviderReviewsToggle enabled={reviews.enabled} /> : null}
            </div>
            <div className="scheduler-item-meta">
              <span
                className={reviews.enabled ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
                data-testid="provider-reviews-state"
              >
                {reviews.enabled ? 'Açık' : 'Kapalı'}
              </span>
            </div>

            <h3 className="operations-subheading">Son değişiklikler</h3>
            {reviews.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }} data-testid="provider-reviews-audit-empty">
                Henüz bir değişiklik kaydı yok; ayar varsayılan (kapalı) durumda.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="provider-reviews-audit">
                  <thead>
                    <tr>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviews.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>
                          {change.previousValue === null ? (
                            <span className="muted">varsayılan (kapalı)</span>
                          ) : (
                            schedulerStateLabel(change.previousValue)
                          )}
                        </td>
                        <td>{schedulerStateLabel(change.newValue)}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {/*
            The campaign engine (CMP-004 S4). Off by default and read
            fail-closed by every engine path; this is its only writer. Unlike
            the switches above it asks for an explicit confirmation, because it
            is the one that starts promotional credit being granted.
          */}
          <SectionCard
            id="kampanya-motoru"
            title="Kampanya motoru"
            subtitle="Açıkken aktif kampanyalar gerçek olaylarda (onay, kanıt, ödeme) promosyon kredisi verir; kapalıyken hiçbir olay kaydedilmez ve değerlendirilmez."
          >
            <div className="scheduler-item-head" data-testid="campaign-engine">
              <div className="scheduler-item-text">
                <p className="scheduler-item-impact">
                  <strong>Açmak</strong> yalnız bundan sonraki olayları etkiler: motor kapalıyken
                  olmuş bir onay, kanıt ya da ödeme için geriye dönük hak ediş üretilmez. Aktif
                  kampanya yoksa motor açık olsa da kimseye kredi verilmez.{' '}
                  <strong>Kapatmak</strong> yeni olay kaydını ve değerlendirmeyi durdurur; verilmiş
                  promosyonların teklif iadesi ve ödeme iadesinde geri alınması aynen sürer.
                  Kampanyalar{' '}
                  {can('CAMPAIGNS_READ') ? <Link href="/campaigns">Kampanyalar</Link> : 'Kampanyalar'} ekranından
                  yönetilir.
                </p>
              </div>
              <span
                className={engine.enabled ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'}
                data-testid="campaign-engine-state"
              >
                {engine.enabled ? 'Açık' : 'Kapalı'}
              </span>
            </div>
            {canToggleEngine ? (
              <CampaignEngineToggle enabled={engine.enabled} />
            ) : (
              <p className="muted" data-testid="campaign-engine-toggle-forbidden">
                Motoru açma/kapama yetkiniz yok. Bu, operasyon ayarlarını düzenleme yetkisinden ayrı tutulan
                tek anahtardır; promosyon kredisi dağıtımını başlatan karar olduğu için ayrı bir izne bağlıdır.
              </p>
            )}

            <h3 className="operations-subheading">Son değişiklikler</h3>
            {engine.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }} data-testid="campaign-engine-audit-empty">
                Henüz bir değişiklik kaydı yok; motor varsayılan (kapalı) durumda.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="campaign-engine-audit">
                  <thead>
                    <tr>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engine.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>
                          {change.previousValue === null ? (
                            <span className="muted">varsayılan (kapalı)</span>
                          ) : (
                            schedulerStateLabel(change.previousValue)
                          )}
                        </td>
                        <td>{schedulerStateLabel(change.newValue)}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            id="zamanlanmis-isler"
            title="Zamanlanmış İşler"
            subtitle="Arka plan işlerinin açık/kapalı durumu. Cron zamanları dağıtım ayarıdır ve buradan değiştirilemez."
          >
            <ul className="scheduler-list" data-testid="scheduler-list">
              {schedulers.jobs.map((job) => {
                const copy = SCHEDULER_JOB_COPY[job.key];

                return (
                  <li className="scheduler-item" key={job.key} data-testid={`scheduler-${job.key}`}>
                    <div className="scheduler-item-head">
                      <div className="scheduler-item-text">
                        <h3 className="scheduler-item-name">{copy.name}</h3>
                        <p className="scheduler-item-impact">{copy.impact}</p>
                      </div>
                      {canToggleSchedulers ? (
                        <SchedulerToggle job={job.key} jobName={copy.name} enabled={job.enabled} />
                      ) : null}
                    </div>

                    <div className="scheduler-item-meta">
                      <span
                        className={
                          job.enabled ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'
                        }
                        data-testid={`scheduler-state-${job.key}`}
                      >
                        {job.enabled ? 'Açık' : 'Kapalı'}
                      </span>
                      <span className="meta-pill">
                        cron <code>{job.cron}</code>
                      </span>
                      {job.lastRun ? (
                        <span className="meta-pill">
                          son çalışma {formatDateTime(job.lastRun.finishedAt)} ·{' '}
                          {RUN_OUTCOME_LABELS[job.lastRun.outcome] ?? job.lastRun.outcome}
                          {job.lastRun.summary ? ` · ${job.lastRun.summary}` : ''}
                        </span>
                      ) : (
                        <span className="meta-pill meta-pill-muted">bu sunucuda çalışmadı</span>
                      )}
                    </div>

                    {/* Shown before the switch is used, not after: an operator
                        deciding whether to flip a money job needs to read what
                        it will start while the switch is still off. */}
                    {copy.confirmation ? (
                      <p className="scheduler-item-warning" role="note">
                        {copy.confirmation}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </SectionCard>

          <SectionCard
            title="Zamanlanmış iş değişiklikleri"
            subtitle="Her açma/kapama işleminde iş, eski durum, yeni durum, yönetici ve zaman kaydedilir."
          >
            {schedulers.recentChanges.length === 0 ? (
              <p className="muted" style={{ margin: 0 }} data-testid="scheduler-audit-empty">
                Henüz bir değişiklik kaydı yok.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="scheduler-audit">
                  <thead>
                    <tr>
                      <th>İş</th>
                      <th>Eski</th>
                      <th>Yeni</th>
                      <th>Yönetici</th>
                      <th>Zaman</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedulers.recentChanges.map((change) => (
                      <tr key={change.id}>
                        <td>{OPERATIONS_SETTING_LABELS[change.setting] ?? change.setting}</td>
                        <td>
                          {change.previousValue === null ? (
                            <span className="muted">varsayılan (kapalı)</span>
                          ) : (
                            schedulerStateLabel(change.previousValue)
                          )}
                        </td>
                        <td>{schedulerStateLabel(change.newValue)}</td>
                        <td>{change.changedBy?.name ?? '-'}</td>
                        <td>{formatDateTime(change.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>

        <div className="admin-side-column">
          <SectionCard title="Yalnız yeni teklifleri etkiler">
            <p className="muted" style={{ margin: 0 }}>
              Her teklif, oluşturulduğu andaki iade süresini ve kesin iade zamanını kendi üzerinde
              saklar. İade işçisi bu kaydı okur, güncel ayarı değil. Bugün{' '}
              {settings.defaultUnviewedOfferRefundWindowHours} saatle oluşturulmuş bir teklif,
              yarın bu ayar değişse bile kendi süresini korur.
            </p>
          </SectionCard>

          <SectionCard title="Zamanlanmış işler nasıl çalışır">
            <p className="muted" style={{ margin: 0 }}>
              Her iş kendi cron zamanında uyanır ve o anda bu ayarı okur. Açtığınız bir iş
              sıradaki cron çalışmasında devreye girer, kapattığınız iş sıradaki çalışmada hiçbir
              şey yapmaz; sunucuyu yeniden başlatmanız gerekmez. Ayar okunamazsa iş kapalı kabul
              edilir. Cron zamanları dağıtım ayarıdır ve buradan değiştirilemez; elle çalıştırma
              düğmesi bilinçli olarak yoktur.
            </p>
          </SectionCard>

          <SectionCard title="Son çalışma bilgisi">
            <p className="muted" style={{ margin: 0 }}>
              Son çalışma bilgisi bu API sunucusunun belleğinde tutulur: yeniden başlatmada
              sıfırlanır ve birden fazla sunucu varsa her biri kendi çalışmasını gösterir. Kalıcı
              kayıt yalnızca yönetici değişiklikleri için tutulur.
            </p>
          </SectionCard>

          <SectionCard title="Hizmet verene gösterilen metin">
            <p className="muted" style={{ margin: 0 }} data-testid="operations-settings-notice">
              {settings.unviewedOfferRefundNotice}
            </p>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}

/** `true`/`false` as the audit trail stores them, in the panel's own words. */
function schedulerStateLabel(value: string): string {
  return value === 'true' ? 'Açık' : 'Kapalı';
}
