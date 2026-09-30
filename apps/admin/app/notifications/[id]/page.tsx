import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  NotificationLogEntry,
  notificationChannelLabel,
  notificationStatusBadgeClass,
  notificationStatusLabel,
  notificationStatusMeaning,
  notificationTemplateLabel,
  requireAdmin,
} from '../../../lib/api';
import { NotificationRetryButton } from '../../../components/notification-retry-button';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';

type NotificationDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ retry?: string; message?: string }>;
};

/**
 * One notification row (#47, ADMIN-DESIGN-001 Faz 3G). The design has no
 * screen for it; it is built on the detail template: a way back to the list,
 * the summary card (status and channel, when it was made, the template, the
 * masked recipient, a strip with the four facts the old stat cards held and
 * the attempt count), the retry action, then "Gönderim" and "İlişkili
 * kayıtlar".
 *
 * Unchanged: the page is NOTIFICATION_LOGS_READ; "Yeniden gönder" is drawn
 * only for a row the API calls retryable and a session holding
 * NOTIFICATION_RETRY, and posts the same form; the request link needs
 * REQUESTS_READ; the recipient is only ever the masked value.
 */
export default async function NotificationDetailPage({
  params,
  searchParams,
}: NotificationDetailPageProps) {
  const { can } = await requireAdmin('NOTIFICATION_LOGS_READ');
  const canRetry = can('NOTIFICATION_RETRY');
  const { id } = await params;
  const { retry, message } = await searchParams;

  const entry = await fetchOrNotFound(() =>
    apiFetch<NotificationLogEntry>(`/notification-logs/${encodeURIComponent(id)}`),
  );

  const statusTone = entry.status === 'SENT' ? 'success' : entry.status === 'FAILED' ? 'danger' : 'warning';
  const facts: SummaryItem[] = [
    { label: 'Kanal', value: notificationChannelLabel(entry.channel) },
    {
      label: 'Durum',
      value: notificationStatusLabel(entry.status),
      tone: statusTone,
      testId: 'notification-fact-status',
    },
    { label: 'Alıcı (maskeli)', value: <span className="cell-break">{entry.maskedRecipient}</span> },
    {
      label: 'Hata sınıfı',
      value: entry.errorLabel ?? '—',
      tone: entry.errorLabel ? 'danger' : 'neutral',
    },
    {
      label: 'Deneme',
      value: entry.attemptCount,
      note: entry.lastAttemptAt ? `son ${formatDateTime(entry.lastAttemptAt)}` : undefined,
    },
  ];

  return (
    <main className="system-page notification-detail-page">
      <DetailHeader
        back={{ href: '/notifications', label: 'Gönderilen bildirimler' }}
        badges={
          <>
            <span className={notificationStatusBadgeClass(entry.status)} data-testid="notification-status">
              {notificationStatusLabel(entry.status)}
            </span>
            <span className="badge badge-muted">{notificationChannelLabel(entry.channel)}</span>
          </>
        }
        meta={<>{formatDateTime(entry.createdAt)} tarihinde oluşturuldu</>}
        title={notificationTemplateLabel(entry.template)}
        subtitle={
          <>
            Şablon <code className="cell-break">{entry.template}</code>
          </>
        }
        actions={
          <>
            {/*
              Shown only for a row the API itself calls retryable. A pending or
              sent message, an SMS, and every mail that carried a single-use
              token render no control at all — there is nothing here to hide,
              because the CTA is never built for them.
            */}
            {entry.retryable && canRetry ? (
              <NotificationRetryButton id={entry.id} returnTo={`/notifications/${entry.id}`} />
            ) : null}
            <Link
              className="btn btn-secondary btn-sm"
              href={`/notifications?template=${encodeURIComponent(entry.template)}`}
            >
              Aynı şablonun kayıtları
            </Link>
          </>
        }
        facts={facts}
        factsLabel="Bildirim özeti"
        testId="notification-header"
      />

      <RetryOutcome retry={retry} message={message} />

      <div className="detail-panel">
        <div className="detail-panel-grid">
          <SectionCard title="Gönderim" testId="notification-delivery-card">
            <KeyValueList
              items={[
                {
                  label: 'Şablon',
                  value: (
                    <>
                      {notificationTemplateLabel(entry.template)}
                      <div>
                        <code className="cell-muted cell-break">{entry.template}</code>
                      </div>
                    </>
                  ),
                },
                {
                  label: 'Alıcı',
                  /*
                    The masked form is the only recipient value that exists: the
                    dispatcher masks before writing, so the raw address was never
                    stored and cannot be reconstructed from this screen.
                  */
                  value: (
                    <code className="cell-break" data-testid="notification-masked-recipient">
                      {entry.maskedRecipient}
                    </code>
                  ),
                },
                { label: 'Oluşturulma', value: formatDateTime(entry.createdAt) },
                { label: 'Gönderilme', value: entry.sentAt ? formatDateTime(entry.sentAt) : null },
                { label: 'Başarısızlık', value: entry.failedAt ? formatDateTime(entry.failedAt) : null },
                {
                  label: 'Durum',
                  value: (
                    <>
                      <span className={notificationStatusBadgeClass(entry.status)}>
                        {notificationStatusLabel(entry.status)}
                      </span>
                      {notificationStatusMeaning(entry.status) ? (
                        <p className="detail-muted-note notification-status-meaning" data-testid="notification-status-meaning">
                          {notificationStatusMeaning(entry.status)}
                        </p>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Deneme sayısı',
                  value: (
                    <>
                      <span data-testid="notification-attempt-count">{entry.attemptCount}</span>
                      {entry.lastAttemptAt ? (
                        <span className="cell-muted"> · son deneme {formatDateTime(entry.lastAttemptAt)}</span>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Hata sınıfı',
                  value: entry.errorLabel ? (
                    <span data-testid="notification-error-label">
                      {entry.errorLabel} <code className="cell-muted">{entry.errorCode}</code>
                    </span>
                  ) : null,
                },
                {
                  label: 'Sağlayıcı mesaj kimliği',
                  value: entry.providerMessageId ? (
                    <code className="cell-break">{entry.providerMessageId}</code>
                  ) : entry.providerMessageIdRedacted ? (
                    <span className="cell-muted">Güvenlik nedeniyle gizlendi</span>
                  ) : null,
                },
              ]}
            />

            <div className="notice notification-audit-note">
              Bu kayıt denetim amaçlıdır. Mesaj içeriği, doğrulama kodu, bağlantı adresi ve ham
              alıcı bilgisi hiçbir zaman saklanmaz.
              {entry.retryable ? (
                <>
                  {' '}
                  Yeniden gönderimde e-posta, bu kaydın içeriğinden değil, güncel kayıtlardan
                  yeniden oluşturulur ve aynı kayıt üzerinde tek bir denemeye dönüşür.
                </>
              ) : entry.retryBlockLabel ? (
                <> {entry.retryBlockLabel}</>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="İlişkili kayıtlar" testId="notification-related-card">
            <KeyValueList
              items={[
                {
                  label: 'Talep',
                  value: entry.requestId ? (
                    can('REQUESTS_READ') ? (
                      <Link className="cell-link" href={`/requests/${entry.requestId}`}>
                        <code className="cell-break">{entry.requestId}</code>
                      </Link>
                    ) : (
                      <code className="cell-break">{entry.requestId}</code>
                    )
                  ) : null,
                },
                {
                  label: 'Kullanıcı',
                  /*
                    Read-only on purpose. The admin user screens cover admin
                    accounts only, so a customer or provider id has no destination
                    here that is guaranteed to exist — and resolving it to find one
                    would mean reading personal data this screen has no need for.
                  */
                  value: entry.userId ? (
                    <code className="cell-break" data-testid="notification-user-id">
                      {entry.userId}
                    </code>
                  ) : null,
                },
                { label: 'Kayıt kimliği', value: <code className="cell-break">{entry.id}</code> },
              ]}
            />

            <div className="inline-actions notification-related-actions">
              {entry.requestId ? (
                <Link
                  className="btn btn-ghost btn-sm"
                  href={`/notifications?requestId=${encodeURIComponent(entry.requestId)}`}
                >
                  Bu talebin bildirimleri
                </Link>
              ) : null}
              <Link className="btn btn-ghost btn-sm" href="/notifications">
                Tüm kayıtlar
              </Link>
            </div>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}

/**
 * What the last retry did, if this render followed one.
 *
 * `failed` is its own case rather than folded into `error`: the attempt really
 * ran, so the row's error class below is the explanation, and telling the
 * operator the request failed would be wrong.
 */
function RetryOutcome({ retry, message }: { retry?: string; message?: string }) {
  if (retry === 'sent') {
    return (
      <div className="notice notice-success detail-notice" role="status" data-testid="notification-retry-result">
        Bildirim yeniden gönderildi.
      </div>
    );
  }

  if (retry === 'failed') {
    return (
      <div className="notice notice-error detail-notice" role="alert" data-testid="notification-retry-result">
        Yeniden gönderim denendi ancak başarısız oldu. Aşağıdaki hata sınıfına bakın.
      </div>
    );
  }

  if (retry === 'error') {
    return (
      <div className="notice notice-error detail-notice" role="alert" data-testid="notification-retry-result">
        {message || 'Yeniden gönderim başlatılamadı.'}
      </div>
    );
  }

  return null;
}
