import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  NotificationLogEntry,
  notificationChannelLabel,
  notificationStatusBadgeClass,
  notificationStatusLabel,
  notificationTemplateLabel,
  requireAdmin,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';

type NotificationDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function NotificationDetailPage({ params }: NotificationDetailPageProps) {
  await requireAdmin();
  const { id } = await params;

  const entry = await fetchOrNotFound(() =>
    apiFetch<NotificationLogEntry>(`/notification-logs/${id}`),
  );

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Bildirim Geçmişi', href: '/notifications' },
          { label: 'Detay' },
        ]}
        title={notificationTemplateLabel(entry.template)}
        subtitle={
          <>
            <span className={notificationStatusBadgeClass(entry.status)}>
              {notificationStatusLabel(entry.status)}
            </span>{' '}
            <span className="muted">
              · {notificationChannelLabel(entry.channel)} · {formatDateTime(entry.createdAt)}
            </span>
          </>
        }
        actions={
          <Link
            className="btn btn-ghost btn-sm"
            href={`/notifications?template=${encodeURIComponent(entry.template)}`}
          >
            Aynı şablonun kayıtları
          </Link>
        }
      />

      <section className="stat-grid">
        <StatCard label="Kanal" value={notificationChannelLabel(entry.channel)} />
        <StatCard
          label="Durum"
          value={notificationStatusLabel(entry.status)}
          tone={entry.status === 'SENT' ? 'success' : entry.status === 'FAILED' ? 'error' : 'warning'}
        />
        <StatCard label="Alıcı (maskeli)" value={entry.maskedRecipient} />
        <StatCard
          label="Hata sınıfı"
          value={entry.errorLabel ?? '-'}
          tone={entry.errorLabel ? 'error' : 'neutral'}
        />
      </section>

      <div className="detail-grid">
        <div className="stack">
          <SectionCard title="Gönderim">
            <dl className="meta-row">
              <dt>Şablon</dt>
              <dd>
                {notificationTemplateLabel(entry.template)}{' '}
                <code style={{ fontSize: 11 }}>{entry.template}</code>
              </dd>
              <dt>Alıcı</dt>
              <dd>
                {/*
                  The masked form is the only recipient value that exists: the
                  dispatcher masks before writing, so the raw address was never
                  stored and cannot be reconstructed from this screen.
                */}
                <code data-testid="notification-masked-recipient">{entry.maskedRecipient}</code>
              </dd>
              <dt>Oluşturulma</dt>
              <dd>{formatDateTime(entry.createdAt)}</dd>
              <dt>Gönderilme</dt>
              <dd>{entry.sentAt ? formatDateTime(entry.sentAt) : <span className="muted">-</span>}</dd>
              <dt>Başarısızlık</dt>
              <dd>
                {entry.failedAt ? formatDateTime(entry.failedAt) : <span className="muted">-</span>}
              </dd>
              <dt>Hata sınıfı</dt>
              <dd>
                {entry.errorLabel ? (
                  <span data-testid="notification-error-label">
                    {entry.errorLabel}{' '}
                    <code style={{ fontSize: 11 }}>{entry.errorCode}</code>
                  </span>
                ) : (
                  <span className="muted">-</span>
                )}
              </dd>
              <dt>Sağlayıcı mesaj kimliği</dt>
              <dd>
                {entry.providerMessageId ? (
                  <code style={{ fontSize: 12 }}>{entry.providerMessageId}</code>
                ) : entry.providerMessageIdRedacted ? (
                  <span className="muted">Güvenlik nedeniyle gizlendi</span>
                ) : (
                  <span className="muted">-</span>
                )}
              </dd>
            </dl>

            <div className="notice" style={{ marginTop: 12 }}>
              Bu kayıt yalnız denetim amaçlıdır. Mesaj içeriği, doğrulama kodu, bağlantı adresi ve
              ham alıcı bilgisi hiçbir zaman saklanmaz; bu ekrandan yeniden gönderim yapılamaz.
            </div>
          </SectionCard>
        </div>

        <div className="stack">
          <SectionCard title="İlişkili kayıtlar">
            <dl className="meta-row">
              <dt>Talep</dt>
              <dd>
                {entry.requestId ? (
                  <Link className="cell-link" href={`/requests/${entry.requestId}`}>
                    <code style={{ fontSize: 12 }}>{entry.requestId}</code>
                  </Link>
                ) : (
                  <span className="muted">-</span>
                )}
              </dd>
              <dt>Kullanıcı</dt>
              <dd>
                {/*
                  Read-only on purpose. The admin user screens cover admin
                  accounts only, so a customer or provider id has no destination
                  here that is guaranteed to exist — and resolving it to find one
                  would mean reading personal data this screen has no need for.
                */}
                {entry.userId ? (
                  <code style={{ fontSize: 12 }} data-testid="notification-user-id">
                    {entry.userId}
                  </code>
                ) : (
                  <span className="muted">-</span>
                )}
              </dd>
              <dt>Kayıt kimliği</dt>
              <dd>
                <code style={{ fontSize: 12 }}>{entry.id}</code>
              </dd>
            </dl>

            <div className="inline-actions" style={{ marginTop: 12 }}>
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
