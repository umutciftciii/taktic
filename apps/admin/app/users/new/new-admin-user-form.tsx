'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { SectionCard } from '../../../components/section-card';
import { createAdminUserAction } from '../actions';
import { INVITE_LINK_IDLE } from '../invite-link-state';
import { InviteLinkError, InviteLinkPanel } from '../invite-link-panel';

/**
 * Creates a staff account and shows its first invite link once.
 *
 * The account is created as a staff account with no role. It holds no
 * permission until a super admin assigns a role on its page. The link is
 * returned in the action state and never in the address bar
 * (see invite-link-state).
 */
export function NewAdminUserForm() {
  const [state, submit, pending] = useActionState(createAdminUserAction, INVITE_LINK_IDLE);

  if (state.kind === 'issued') {
    return (
      <SectionCard title="Davet bağlantısı hazır" className="detail-tab-card" testId="admin-user-issued">
        <p className="detail-muted-note">
          Admin kullanıcısı oluşturuldu. Aşağıdaki bağlantıyı kopyalayıp WhatsApp / SMS / e-posta ile manuel olarak
          paylaşın. Bağlantı 72 saat geçerlidir ve bu ekrandan ayrıldığınızda bir daha gösterilmez.
        </p>
        <InviteLinkPanel inviteUrl={state.inviteUrl} expiresAt={state.expiresAt} intro="Şifre belirleme bağlantısı:" />
        <div className="detail-form-footer">
          <p className="detail-form-footer-note">Sıradaki adım: kullanıcı detayında bu hesaba bir rol atayın.</p>
          <div className="detail-form-footer-actions">
            <Link className="btn btn-secondary" href="/users">
              Listeye dön
            </Link>
            <Link className="btn btn-primary" href={`/users/${state.userId}`}>
              Kullanıcı detayına git
            </Link>
          </div>
        </div>
      </SectionCard>
    );
  }

  const values = state.kind === 'error' ? state.values : undefined;

  return (
    <SectionCard
      title="Yeni admin bilgileri"
      actions={<span className="section-card-meta">Rol atanana kadar bu hesabın hiçbir yetkisi yoktur</span>}
      className="detail-tab-card"
      testId="admin-user-create-card"
    >
      {state.kind === 'error' ? <InviteLinkError message={state.message} /> : null}

      <form action={submit} className="compact-form" data-testid="admin-user-create-form">
        <div className="compact-field-grid">
          <label className="field field-4">
            <span>Ad Soyad *</span>
            <input
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={120}
              defaultValue={values?.name ?? ''}
              autoComplete="name"
            />
          </label>
          <label className="field field-4">
            <span>E-posta *</span>
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              defaultValue={values?.email ?? ''}
              autoComplete="email"
            />
            <span className="help-text">Personel bu adresle giriş yapar.</span>
          </label>
          <label className="field field-4">
            <span>Telefon (opsiyonel)</span>
            <input name="phone" type="tel" maxLength={32} defaultValue={values?.phone ?? ''} autoComplete="tel" />
          </label>
        </div>
        <div className="detail-form-footer">
          <p className="detail-form-footer-note">
            Şifre belirleme bağlantısı oluşturulduktan sonra bu ekranda bir kez görüntülenir.
          </p>
          <div className="detail-form-footer-actions">
            <Link className="btn btn-secondary" href="/users">
              Vazgeç
            </Link>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              Admin Kullanıcısı Oluştur
            </button>
          </div>
        </div>
      </form>
    </SectionCard>
  );
}
