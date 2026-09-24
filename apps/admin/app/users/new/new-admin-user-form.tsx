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
      <SectionCard title="Davet bağlantısı hazır" className="card-wide">
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
          Admin kullanıcısı oluşturuldu. Aşağıdaki bağlantıyı kopyalayıp WhatsApp / SMS / e-posta
          ile manuel olarak paylaşın. Bağlantı 72 saat geçerlidir.
        </p>
        <InviteLinkPanel
          inviteUrl={state.inviteUrl}
          expiresAt={state.expiresAt}
          intro="Şifre belirleme bağlantısı:"
        />
        <div className="inline-actions" style={{ marginTop: 16 }}>
          <Link className="btn btn-secondary btn-sm" href={`/users/${state.userId}`}>
            Kullanıcı detayına git
          </Link>
          <Link className="btn btn-ghost btn-sm" href="/users">
            Listeye dön
          </Link>
        </div>
      </SectionCard>
    );
  }

  const values = state.kind === 'error' ? state.values : undefined;

  return (
    <SectionCard title="Yeni admin bilgileri" className="card-wide">
      <p className="muted" style={{ marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
        Oluşturulan kullanıcı bir personel hesabıdır ve rol atanana kadar hiçbir yetkisi yoktur.
        Şifre belirleme bağlantısı üretilir ve oluşturulduktan sonra ekranda bir kez görüntülenir.
      </p>

      {state.kind === 'error' ? <InviteLinkError message={state.message} /> : null}

      <form action={submit} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <label className="form-row">
          <span>Ad Soyad</span>
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
        <label className="form-row">
          <span>E-posta</span>
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            defaultValue={values?.email ?? ''}
            autoComplete="email"
          />
        </label>
        <label className="form-row">
          <span>Telefon (opsiyonel)</span>
          <input
            name="phone"
            type="tel"
            maxLength={32}
            defaultValue={values?.phone ?? ''}
            autoComplete="tel"
          />
        </label>
        <div className="inline-actions" style={{ marginTop: 4 }}>
          <button className="btn btn-primary" type="submit" disabled={pending}>
            Admin Kullanıcısı Oluştur
          </button>
          <Link className="btn btn-ghost btn-sm" href="/users">
            Vazgeç
          </Link>
        </div>
      </form>
    </SectionCard>
  );
}
