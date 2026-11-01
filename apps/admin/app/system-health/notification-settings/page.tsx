import Link from 'next/link';
import { AuditTimeline } from '../../../components/audit-timeline';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { RouteDialog } from '../../../components/route-dialog';
import { SectionCard } from '../../../components/section-card';
import { Toggle } from '../../../components/toggle';
import {
  formatDateTime,
  getOpsAlertRecipientsAudit,
  getOpsAlertRouting,
  listOpsAlertRecipients,
  requireAdmin,
} from '../../../lib/api';
import { parsePage } from '../../../lib/list-query';
import {
  EMAIL_ROUTING_LABELS,
  OPS_ALERT_RECIPIENT_LIMIT,
  RECIPIENT_STATUS_BADGES,
  RECIPIENT_STATUS_LABELS,
  recipientErrorText,
  type RecipientView,
  type RoutingState,
} from '../../../lib/ops-alert-recipients';
import { recipientStaleMessage } from '../../../lib/status-conflicts';
import { RecipientForm } from './recipient-form';

/**
 * Admin > Sistem sağlığı > Operasyon alarmları > Bildirim ayarları
 * (OBS-ALERT-002 PR-B): the e-mail recipients of the operations alerts.
 *
 * OPS_ALERT_RECIPIENTS_READ opens it. The API sends masked addresses only; a
 * full address is never part of this page. Without OPS_ALERT_RECIPIENTS_WRITE
 * the list is a list: no add control, no edit link, and the form is not drawn
 * even when its link is typed by hand. The switches in the table only show the
 * recipient's choices; they are changed in the edit window, which sends the
 * row's version so a stale form is refused rather than overwriting.
 *
 * Where the next tasks attach: each row's actions cell (`ops-alert-recipient-
 * actions`) takes pause / delete / address replacement / reveal / test, and the
 * SUPER_ADMIN routing panel (cutover, revert, key operations) goes between the
 * status strip and the table.
 *
 * Not drawn on purpose: no loading.tsx above this page (the window is a query
 * parameter on it, and a loading boundary above a query window re-suspends the
 * dialog's own page).
 */

export const dynamic = 'force-dynamic';

const PATH = '/system-health/notification-settings';

type NotificationSettingsPageProps = {
  searchParams: Promise<{ alici?: string; ok?: string; error?: string; gecmisSayfa?: string }>;
};

const OK_MESSAGES: Record<string, string> = {
  created: 'Alıcı eklendi. Bundan sonraki alarm e-postaları seçtiği bildirim türleri için ona da gider.',
  updated: 'Alıcı güncellendi.',
};

const COLUMNS: DataColumn[] = [
  { key: 'label', label: 'Etiket' },
  { key: 'address', label: 'Adres (maskeli)' },
  { key: 'warning', label: 'Uyarı' },
  { key: 'critical', label: 'Kritik' },
  { key: 'recovery', label: 'Düzelme' },
  { key: 'status', label: 'Durum' },
  { key: 'lastSent', label: 'Son gönderim' },
  { key: 'lastError', label: 'Son hata' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

const SWITCH_TITLES = { notifyWarning: 'Uyarı', notifyCritical: 'Kritik', notifyRecovery: 'Düzelme' } as const;

function StatusStrip({ routing, count }: { routing: RoutingState; count: number }) {
  const keyIds = Object.entries(routing.keyIds);
  const hmacVersions = Object.entries(routing.hmacVersions);
  return (
    <div className="system-health-alert-channels" data-testid="ops-alert-status-strip">
      <span data-testid="ops-alert-routing-mode" data-routing={routing.emailRouting}>
        Yönlendirme: {EMAIL_ROUTING_LABELS[routing.emailRouting]}
      </span>
      {' · '}
      <span data-testid="ops-alert-recipient-count">{count}/{OPS_ALERT_RECIPIENT_LIMIT} alıcı</span>
      {' · '}
      <span data-channel="telegram" data-configured={String(routing.telegramConfigured)}>
        Telegram: {routing.telegramConfigured ? 'tanımlı (kritik uyarılar)' : 'tanımlı değil'}
      </span>
      {/* Key versions matter only while a rotation is in flight: several of either. */}
      {keyIds.length > 1 || hmacVersions.length > 1 ? (
        <div className="cell-muted" data-testid="ops-alert-key-versions">
          Anahtar sürümleri — şifreleme: {keyIds.map(([id, n]) => `${id}: ${n}`).join(', ')} · adres özeti:{' '}
          {hmacVersions.map(([version, n]) => `v${version}: ${n}`).join(', ')}
        </div>
      ) : null}
    </div>
  );
}

function DeliveryState({ recipient }: { recipient: RecipientView }) {
  return (
    <div className="cell-stack">
      <span>{recipient.lastSentAt ? formatDateTime(recipient.lastSentAt) : <span className="cell-muted">Henüz yok</span>}</span>
    </div>
  );
}

function LastError({ recipient }: { recipient: RecipientView }) {
  if (!recipient.lastErrorCode && recipient.consecutiveFailures === 0) return <span className="cell-muted">—</span>;
  return (
    <div className="cell-stack">
      {recipient.lastErrorCode ? <span className="cell-break">{recipientErrorText(recipient.lastErrorCode)}</span> : null}
      {recipient.consecutiveFailures > 0 ? (
        <span className="cell-muted" data-testid="ops-alert-recipient-failures">
          {recipient.consecutiveFailures} ardışık hata
        </span>
      ) : null}
    </div>
  );
}

export default async function NotificationSettingsPage({ searchParams }: NotificationSettingsPageProps) {
  const { can } = await requireAdmin('OPS_ALERT_RECIPIENTS_READ');
  const canWrite = can('OPS_ALERT_RECIPIENTS_WRITE');

  const params = await searchParams;
  const okText = params.ok ? (OK_MESSAGES[params.ok] ?? null) : null;
  const errorText = recipientStaleMessage(params.error);
  const historyPage = parsePage(params.gecmisSayfa);

  const [recipients, routing, history] = await Promise.all([
    listOpsAlertRecipients(),
    getOpsAlertRouting(),
    getOpsAlertRecipientsAudit(historyPage),
  ]);

  const atLimit = recipients.length >= OPS_ALERT_RECIPIENT_LIMIT;
  const labels = new Map(recipients.map((recipient) => [recipient.id, recipient.label]));
  // The log names a recipient by id only; the page gives it the label it has now.
  const audit = {
    ...history,
    items: history.items.map((entry) =>
      entry.target && !entry.target.label && labels.has(entry.target.id)
        ? { ...entry, target: { ...entry.target, label: labels.get(entry.target.id) } }
        : entry,
    ),
  };

  // The window is a query parameter: `yeni`, or the id of the recipient to edit.
  const openKey = canWrite ? (params.alici ?? '').trim() : '';
  const adding = openKey === 'yeni' && !atLimit;
  // A typed or stale `?alici=yeni` at the limit: say why no window opened.
  const addRefused = openKey === 'yeni' && atLimit;
  const editing = openKey && openKey !== 'yeni' ? (recipients.find((recipient) => recipient.id === openKey) ?? null) : null;
  const missing = openKey !== '' && openKey !== 'yeni' && !editing;

  return (
    <main className="system-health-page" data-testid="ops-alert-recipients-page">
      <PageHeader
        title="Bildirim ayarları"
        subtitle="Operasyon alarmlarının e-postalarını alan kişiler. Adresler şifreli saklanır ve burada yalnız maskeli görünür."
        breadcrumbs={[
          { label: 'Sistem sağlığı', href: '/system-health' },
          { label: 'Bildirim ayarları' },
        ]}
        actions={
          canWrite ? (
            atLimit ? (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled
                  aria-describedby="ops-alert-add-reason"
                  data-testid="ops-alert-recipient-add"
                >
                  Alıcı ekle
                </button>
                <p className="cell-muted" id="ops-alert-add-reason" data-testid="ops-alert-recipient-add-reason">
                  En fazla {OPS_ALERT_RECIPIENT_LIMIT} alıcı eklenebilir; yeni alıcı için önce birini silin.
                </p>
              </>
            ) : (
              <Link className="btn btn-primary" href={`${PATH}?alici=yeni`} scroll={false} data-testid="ops-alert-recipient-add">
                Alıcı ekle
              </Link>
            )
          ) : null
        }
      />

      {okText ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="ops-alert-recipients-ok">
          {okText}
        </div>
      ) : null}
      {errorText ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="ops-alert-recipients-error">
          {errorText}
        </div>
      ) : null}

      <div className="settings-stack">
        <SectionCard title="Durum" padded={false} testId="ops-alert-status">
          <StatusStrip routing={routing} count={recipients.length} />
        </SectionCard>

        {/* SUPER_ADMIN routing panel (task B4) attaches here. */}

        {routing.emailRouting === 'ENV_LEGACY' ? (
          <div className="notice notice-warning" data-testid="ops-alert-env-legacy-notice">
            Bu alıcılar geçiş yapılana kadar bildirim almaz; şu an bildirimler OPS_ALERT_EMAIL adresine gidiyor.
          </div>
        ) : null}

        <SectionCard
          title="E-posta alıcıları"
          subtitle="Her alıcı, seçtiği bildirim türleri için alarm e-postası alır."
          padded={false}
          testId="ops-alert-recipients"
        >
          {recipients.length === 0 ? (
            <EmptyState
              title="Henüz alıcı yok"
              description={canWrite ? '“Alıcı ekle” ile ilk alıcıyı tanımlayın.' : 'Bir alıcı eklendiğinde burada görünür.'}
            />
          ) : (
            <DataTable caption="Alarm e-postası alıcıları" columns={COLUMNS} minWidth={980} testId="ops-alert-recipient-table">
              {recipients.map((recipient) => (
                <tr
                  key={recipient.id}
                  data-testid="ops-alert-recipient-row"
                  data-recipient-id={recipient.id}
                  data-status={recipient.status}
                >
                  <td>
                    <strong className="cell-break">{recipient.label}</strong>
                    {recipient.isLastCritical ? (
                      <span className="cell-muted" data-testid="ops-alert-recipient-last-critical">
                        {' '}
                        · son kritik alıcı
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <code className="cell-break">{recipient.maskedAddress}</code>
                  </td>
                  {(['notifyWarning', 'notifyCritical', 'notifyRecovery'] as const).map((name) => (
                    <td key={name}>
                      <Toggle
                        checked={recipient[name]}
                        label={`${recipient.label}: ${SWITCH_TITLES[name]}`}
                        stateText={false}
                        disabled
                        testId={`ops-alert-toggle-${name}`}
                      />
                    </td>
                  ))}
                  <td>
                    <span className={RECIPIENT_STATUS_BADGES[recipient.status]}>{RECIPIENT_STATUS_LABELS[recipient.status]}</span>
                  </td>
                  <td>
                    <DeliveryState recipient={recipient} />
                  </td>
                  <td>
                    <LastError recipient={recipient} />
                  </td>
                  <td className="col-actions">
                    <div className="seo-row-actions" data-testid="ops-alert-recipient-actions">
                      {canWrite ? (
                        <Link
                          className="btn btn-secondary btn-sm"
                          href={`${PATH}?alici=${encodeURIComponent(recipient.id)}`}
                          scroll={false}
                          data-testid="ops-alert-recipient-edit"
                        >
                          Düzenle
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </SectionCard>

        <AuditTimeline
          page={audit}
          title="Alıcı geçmişi"
          empty="Henüz alıcı değişikliği kaydedilmedi."
          testId="ops-alert-audit"
          pager={{ path: PATH, params: {}, pageParam: 'gecmisSayfa' }}
        />
      </div>

      {adding ? (
        <RouteDialog title="Alıcı ekle" closeHref={PATH} testId="ops-alert-recipient-dialog">
          <RecipientForm mode={{ kind: 'create' }} cancelHref={PATH} />
        </RouteDialog>
      ) : null}
      {addRefused ? (
        <div className="notice notice-warning detail-notice" role="status" data-testid="ops-alert-recipient-limit-notice">
          En fazla {OPS_ALERT_RECIPIENT_LIMIT} alıcı eklenebilir; yeni alıcı için önce birini silin.
        </div>
      ) : null}
      {missing ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="ops-alert-recipient-missing">
          Bu bağlantının gösterdiği alıcı bulunamadı; silinmiş olabilir.
        </div>
      ) : null}
      {editing ? (
        <RouteDialog title="Alıcıyı düzenle" closeHref={PATH} testId="ops-alert-recipient-dialog">
          <RecipientForm
            key={editing.id}
            mode={{ kind: 'edit', recipientId: editing.id, version: editing.version, maskedAddress: editing.maskedAddress }}
            defaults={{
              label: editing.label,
              notifyWarning: editing.notifyWarning,
              notifyCritical: editing.notifyCritical,
              notifyRecovery: editing.notifyRecovery,
            }}
            cancelHref={PATH}
          />
        </RouteDialog>
      ) : null}
    </main>
  );
}
