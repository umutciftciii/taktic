'use client';

import { formatDateTime } from '@taktic/shared';
import { useActionState, useRef, useState } from 'react';
import type { ProviderInvite } from '../../lib/api';
import { providerInviteAction } from './actions';
import {
  PROVIDER_INVITE_IDLE,
  PROVIDER_INVITE_STATE_LABELS,
  providerInviteStateBadgeClass,
} from './category-taxonomy';

type ProviderInvitePanelProps = {
  categoryId: string;
  categorySlug: string;
  categoryName: string;
  /**
   * Whether a new link may be issued right now — an ACTIVE or DRAFT service.
   *
   * A closed service is refused by the API, so the button is absent rather than
   * present-and-rejected: the screen must never offer an action it knows would
   * come back as an error. The history stays visible either way, because who
   * was approached before a service was withdrawn is exactly what an operator
   * reopening it needs to know.
   */
  canIssue: boolean;
  invites: ProviderInvite[];
  activeCount: number;
};

/**
 * The operator's invitation desk for one service.
 *
 * A client component for one reason, and it is the reason the whole feature is
 * shaped this way: the link may be shown exactly once. `useActionState` keeps
 * the issue result in the component's own state, so the URL appears in the
 * response to the button press and is gone the moment the operator navigates or
 * refreshes — and it cannot come back, because no endpoint will produce it
 * again. A redirect carrying the link, a cookie holding it, or a field on the
 * list below would each have made "shown once" a convention rather than a fact.
 *
 * It still works without JavaScript. `useActionState` forms submit normally and
 * React renders the returned state server-side, so an operator on a browser
 * with scripting off gets the link too — they just copy it by hand instead of
 * with the button.
 */
export function ProviderInvitePanel({
  categoryId,
  categorySlug,
  categoryName,
  canIssue,
  invites,
  activeCount,
}: ProviderInvitePanelProps) {
  // One state for both buttons, so the newest outcome is the only one on
  // screen: withdrawing an invitation replaces the "here is the link" panel
  // rather than leaving it standing next to a message that contradicts it.
  const [notice, submit, pending] = useActionState(providerInviteAction, PROVIDER_INVITE_IDLE);

  return (
    <div className="admin-action-panel" data-testid="provider-invite-panel">
      <h3>Hizmet veren daveti</h3>
      <p>
        Tek kullanımlık bir başvuru bağlantısı üretir. Bağlantıyı alan işletme yalnızca{' '}
        <strong>{categoryName}</strong> hizmetinin adını görür ve bu hizmet için başvuru formunu
        doldurur. Kategori taslak olsa bile çalışır; müşteri kataloğu değişmez.
      </p>
      <p style={{ fontSize: 12 }}>
        Bağlantı 14 gün geçerlidir ve bir kez kullanılabilir. E-posta göndermiyoruz: bağlantıyı
        işletmeye siz iletirsiniz. <strong>Bağlantı yalnızca üretildiği anda görünür</strong> —
        sayfayı yeniledikten sonra bir daha gösterilemez, gerekirse yenisini üretin.
      </p>

      {canIssue ? (
        <form action={submit} className="panel-row">
          <input type="hidden" name="intent" value="issue" />
          <input type="hidden" name="categoryId" value={categoryId} />
          <input type="hidden" name="categorySlug" value={categorySlug} />
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={pending}
            data-testid="provider-invite-create"
          >
            {pending ? 'İşleniyor…' : 'Yeni davet bağlantısı üret'}
          </button>
        </form>
      ) : (
        <p className="badge badge-warn" data-testid="provider-invite-closed">
          Bu hizmet kapalı. Kapalı bir hizmet için yeni davet üretilemez; geçmiş davetler aşağıda
          görünmeye devam eder.
        </p>
      )}

      {notice.kind === 'issued' ? (
        <IssuedLink url={notice.invite.url} expiresAt={notice.invite.expiresAt} />
      ) : null}

      {notice.kind === 'error' ? (
        <p className="badge badge-warn" role="alert" data-testid="provider-invite-error">
          {notice.message}
        </p>
      ) : null}

      {notice.kind === 'revoked' ? (
        <p className="badge badge-good" role="status" data-testid="provider-invite-revoked">
          {notice.alreadyDead
            ? 'Bu bağlantı zaten kullanılmış veya iptal edilmişti; durumu listede görünüyor.'
            : 'Davet bağlantısı iptal edildi. Artık kullanılamaz.'}
        </p>
      ) : null}

      <p className="muted" style={{ fontSize: 12, marginTop: 12 }} data-testid="provider-invite-count">
        {activeCount} geçerli davet, {invites.length} toplam kayıt.
      </p>

      {invites.length === 0 ? (
        <span className="muted">Bu hizmet için henüz davet üretilmedi.</span>
      ) : (
        <ul className="provider-category-list" data-testid="provider-invite-list">
          {invites.map((invite) => (
            <li key={invite.id} data-testid={`provider-invite-${invite.id}`}>
              <span className="provider-category-name">
                <span className={providerInviteStateBadgeClass(invite.state)}>
                  {PROVIDER_INVITE_STATE_LABELS[invite.state]}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatDateTime(invite.createdAt)} · {describeDeadline(invite)}
                  {invite.createdBy?.name ? ` · ${invite.createdBy.name}` : ''}
                </span>
              </span>
              {invite.state === 'ACTIVE' ? (
                <form action={submit}>
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="categoryId" value={categoryId} />
                  <input type="hidden" name="categorySlug" value={categorySlug} />
                  <input type="hidden" name="inviteId" value={invite.id} />
                  <button
                    className="btn btn-ghost btn-sm"
                    type="submit"
                    disabled={pending}
                    data-testid={`provider-invite-revoke-${invite.id}`}
                  >
                    İptal et
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The one moment the link is legible.
 *
 * A read-only input rather than text: it is long, it must be copied exactly,
 * and selecting it is what an operator falls back to when the clipboard API is
 * unavailable — which it is on any non-secure origin, so the button can never
 * be the only way to get the value out.
 */
function IssuedLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    field.current?.select();

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Left selected, and the label says so: the operator copies it by hand.
      setCopied(false);
    }
  }

  return (
    <div className="admin-action-panel is-warning" data-testid="provider-invite-issued">
      <h3>Bağlantı hazır</h3>
      <p style={{ fontSize: 12 }}>
        Bu bağlantıyı şimdi kopyalayın ve işletmeye iletin. Sayfadan ayrıldığınızda bir daha
        gösterilemez. Geçerlilik: <strong>{formatDateTime(expiresAt)}</strong>.
      </p>
      <input
        className="provider-invite-url"
        data-testid="provider-invite-url"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        ref={field}
        value={url}
      />
      <button className="btn btn-secondary btn-sm" onClick={copy} type="button">
        {copied ? 'Kopyalandı' : 'Bağlantıyı kopyala'}
      </button>
    </div>
  );
}

/** What the row says about the clock, in the words the state makes true. */
function describeDeadline(invite: ProviderInvite): string {
  if (invite.usedAt) {
    return `kullanıldı: ${formatDateTime(invite.usedAt)}`;
  }

  if (invite.revokedAt) {
    return `iptal: ${formatDateTime(invite.revokedAt)}`;
  }

  return `son geçerlilik: ${formatDateTime(invite.expiresAt)}`;
}
