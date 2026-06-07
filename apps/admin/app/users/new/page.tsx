import Link from 'next/link';
import { formatDateTime, requireAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { createAdminUserAction } from '../actions';

type SearchParams = {
  error?: string;
  name?: string;
  email?: string;
  phone?: string;
  inviteUrl?: string;
  expiresAt?: string;
  userId?: string;
};

type NewAdminUserPageProps = {
  searchParams: Promise<SearchParams>;
};

export default async function NewAdminUserPage({ searchParams }: NewAdminUserPageProps) {
  await requireAdmin();
  const search = (await searchParams) ?? {};

  const created = Boolean(search.inviteUrl && search.userId);

  return (
    <main className="user-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin Kullanıcıları', href: '/users' },
          { label: 'Yeni' },
        ]}
        title="Yeni Admin Kullanıcısı"
        subtitle="Bir admin kullanıcısı oluşturun ve şifre belirleme bağlantısını manuel paylaşın."
        actions={
          <Link className="btn btn-ghost btn-sm" href="/users">
            ← Listeye dön
          </Link>
        }
      />

      {created ? (
        <SectionCard title="Davet bağlantısı hazır" className="card-wide">
          <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
            Admin kullanıcısı oluşturuldu. Aşağıdaki bağlantıyı kopyalayıp WhatsApp / SMS / e-posta
            ile manuel olarak paylaşın. Bağlantı 72 saat geçerlidir.
          </p>
          <code
            style={{
              display: 'block',
              padding: 10,
              background: 'var(--surface-soft, #f3f4f6)',
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              wordBreak: 'break-all',
            }}
          >
            {search.inviteUrl}
          </code>
          {search.expiresAt ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Son geçerlilik: {formatDateTime(search.expiresAt)}
            </div>
          ) : null}
          <div className="inline-actions" style={{ marginTop: 16 }}>
            <Link className="btn btn-secondary btn-sm" href={`/users/${search.userId}`}>
              Kullanıcı detayına git
            </Link>
            <Link className="btn btn-ghost btn-sm" href="/users">
              Listeye dön
            </Link>
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Yeni admin bilgileri" className="card-wide">
          <p className="muted" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            Oluşturulan kullanıcı <strong>SUPER_ADMIN</strong> rolüne sahip olur ve şifre belirleme
            bağlantısı üretilir. Bağlantı oluşturulduktan sonra ekranda görüntülenir.
          </p>

          {search.error ? (
            <div
              role="alert"
              style={{
                marginBottom: 12,
                padding: 10,
                borderRadius: 8,
                background: 'rgba(220, 38, 38, 0.08)',
                border: '1px solid rgba(220, 38, 38, 0.25)',
                color: 'rgb(153, 27, 27)',
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {search.error}
            </div>
          ) : null}

          <form action={createAdminUserAction} style={{ display: 'grid', gap: 12 }}>
            <label className="form-row">
              <span>Ad Soyad</span>
              <input
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={120}
                defaultValue={search.name ?? ''}
                autoComplete="name"
              />
            </label>
            <label className="form-row">
              <span>E-posta</span>
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                defaultValue={search.email ?? ''}
                autoComplete="email"
              />
            </label>
            <label className="form-row">
              <span>Telefon (opsiyonel)</span>
              <input
                name="phone"
                type="tel"
                maxLength={32}
                defaultValue={search.phone ?? ''}
                autoComplete="tel"
              />
            </label>
            <div className="inline-actions" style={{ marginTop: 4 }}>
              <button className="btn btn-primary" type="submit">
                Admin Kullanıcısı Oluştur
              </button>
              <Link className="btn btn-ghost btn-sm" href="/users">
                Vazgeç
              </Link>
            </div>
          </form>
        </SectionCard>
      )}
    </main>
  );
}
