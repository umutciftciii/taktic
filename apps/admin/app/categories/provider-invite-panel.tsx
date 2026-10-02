'use client';

import { formatDateTime } from '@taktic/shared';
import { useActionState, useRef, useState } from 'react';
import type { ProviderInvite } from '../../lib/api';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { InfoPopover } from '../../components/info-popover';
import { SectionCard } from '../../components/section-card';
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
  /**
   * Whether this session holds PROVIDER_INVITES_ISSUE / PROVIDER_INVITES_REVOKE.
   * Computed on the server; without one, its button is not rendered at all.
   */
  mayIssue: boolean;
  mayRevoke: boolean;
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
  mayIssue,
  mayRevoke,
  invites,
  activeCount,
}: ProviderInvitePanelProps) {
  // One state for both buttons, so the newest outcome is the only one on
  // screen: withdrawing an invitation replaces the "here is the link" panel
  // rather than leaving it standing next to a message that contradicts it.
  const [notice, submit, pending] = useActionState(providerInviteAction, PROVIDER_INVITE_IDLE);

  return (
    <SectionCard
      title={
        <>
          Hizmet veren davetleri
          <InfoPopover label="Davet bağlantısı nasıl çalışır?" size="sm">
            Tek kullanımlık bir başvuru bağlantısı üretir. Bağlantıyı alan işletme yalnızca{' '}
            <strong>{categoryName}</strong> hizmetinin adını görür ve bu hizmet için başvuru formunu doldurur.
            Kategori taslak olsa bile çalışır; müşteri kataloğu değişmez. Bağlantı 14 gün geçerlidir ve bir kez
            kullanılabilir. E-posta göndermiyoruz: bağlantıyı işletmeye siz iletirsiniz. Bağlantı yalnızca
            üretildiği anda görünür — sayfayı yeniledikten sonra bir daha gösterilemez, gerekirse yenisini üretin.
            Geçerli davet yayına hazırlıkta sayılmaz.
          </InfoPopover>
        </>
      }
      actions={
        <>
          <span className="section-card-meta" data-testid="provider-invite-count">
            {activeCount} geçerli davet, {invites.length} toplam kayıt.
          </span>
          {mayIssue && canIssue ? (
            <form action={submit}>
              <input type="hidden" name="intent" value="issue" />
              <input type="hidden" name="categoryId" value={categoryId} />
              <input type="hidden" name="categorySlug" value={categorySlug} />
              <button
                className="btn btn-primary btn-sm"
                type="submit"
                disabled={pending}
                data-testid="provider-invite-create"
              >
                {pending ? 'İşleniyor…' : 'Yeni davet bağlantısı oluştur'}
              </button>
            </form>
          ) : null}
        </>
      }
      padded={false}
      className="detail-tab-card"
      testId="provider-invite-panel"
    >
      <div className="invite-desk-notices">
        {mayIssue && !canIssue ? (
          <p className="notice notice-warning" data-testid="provider-invite-closed">
            Bu hizmet kapalı. Kapalı bir hizmet için yeni davet üretilemez; geçmiş davetler aşağıda
            görünmeye devam eder.
          </p>
        ) : null}

        {notice.kind === 'issued' ? (
          <IssuedLink url={notice.invite.url} expiresAt={notice.invite.expiresAt} />
        ) : null}

        {notice.kind === 'error' ? (
          <p className="notice notice-error" role="alert" data-testid="provider-invite-error">
            {notice.message}
          </p>
        ) : null}

        {notice.kind === 'revoked' ? (
          <p className="notice notice-success" role="status" data-testid="provider-invite-revoked">
            {notice.alreadyDead
              ? 'Bu bağlantı zaten kullanılmış veya iptal edilmişti; durumu listede görünüyor.'
              : 'Davet bağlantısı iptal edildi. Artık kullanılamaz.'}
          </p>
        ) : null}
      </div>

      {invites.length === 0 ? (
        <EmptyState title="Bu hizmet için henüz davet üretilmedi." />
      ) : (
        <DataTable caption="Hizmet veren davetleri" columns={INVITE_COLUMNS} minWidth={720} testId="provider-invite-list">
          {invites.map((invite) => (
            <tr key={invite.id} data-testid={`provider-invite-${invite.id}`}>
              <td className="cell-break">
                {invite.createdBy?.name ?? <span className="cell-muted">Kayıtlı değil</span>}
              </td>
              <td className="cell-nowrap">{formatDateTime(invite.createdAt)}</td>
              <td className="cell-nowrap">{formatDateTime(invite.expiresAt)}</td>
              <td>
                <div className="cell-stack">
                  <span className={providerInviteStateBadgeClass(invite.state)}>
                    {PROVIDER_INVITE_STATE_LABELS[invite.state]}
                  </span>
                  {invite.usedAt || invite.revokedAt ? (
                    <span className="cell-muted">{describeDeadline(invite)}</span>
                  ) : null}
                </div>
              </td>
              <td className="col-actions">
                {mayRevoke && invite.state === 'ACTIVE' ? (
                  <form action={submit}>
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="categoryId" value={categoryId} />
                    <input type="hidden" name="categorySlug" value={categorySlug} />
                    <input type="hidden" name="inviteId" value={invite.id} />
                    {/*
                      Asks first: the link dies for good
                      (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). Issuing a
                      new one stays one press.
                    */}
                    <ConfirmDialog
                      proof="provider-invite.revoke"
                      triggerLabel="İptal et"
                      triggerClassName="btn btn-secondary btn-sm"
                      title="Davet bağlantısı iptal edilsin mi?"
                      consequence={REVOKE_CONSEQUENCE}
                      confirmLabel="Evet, bağlantıyı iptal et"
                      disabled={pending}
                      testId={`provider-invite-revoke-${invite.id}`}
                    />
                  </form>
                ) : (
                  <span className="cell-muted" aria-hidden="true">
                    —
                  </span>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </SectionCard>
  );
}

/** What withdrawing a link does (`POST …/provider-invites/:id/revoke`). */
const REVOKE_CONSEQUENCE = (
  <ul data-testid="invite-revoke-impact">
    <li>
      <strong>Bağlantı kalıcı olarak geçersiz olur:</strong> işletmeye iletilmişse artık başvuru için kullanılamaz ve
      yeniden açılamaz.
    </li>
    <li>Gerekirse “Yeni davet bağlantısı oluştur” ile ayrıca yeni bir bağlantı üretip işletmeye iletebilirsiniz.</li>
    <li>Bağlantı kullanılarak yapılmış bir başvuru varsa o başvuru değişmez.</li>
  </ul>
);

/**
 * The design's invitation table, less its "Davet edilen" column: a link is not
 * issued to anybody in particular — the record holds who made it and when,
 * never who received it — so there is no invitee to show.
 */
const INVITE_COLUMNS: DataColumn[] = [
  { key: 'creator', label: 'Oluşturan' },
  { key: 'created', label: 'Oluşturma' },
  { key: 'expires', label: 'Son geçerlilik' },
  { key: 'state', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

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
    <div className="catalog-issued-link" data-testid="provider-invite-issued">
      <h3>Bağlantı hazır</h3>
      <p>
        Bu bağlantıyı şimdi kopyalayın ve işletmeye iletin. Sayfadan ayrıldığınızda bir daha
        gösterilemez. Geçerlilik: <strong>{formatDateTime(expiresAt)}</strong>.
      </p>
      <input
        className="provider-invite-url"
        aria-label="Davet bağlantısı"
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

/** When a spent or withdrawn link stopped working, under its state badge. */
function describeDeadline(invite: ProviderInvite): string {
  if (invite.usedAt) {
    return `kullanıldı: ${formatDateTime(invite.usedAt)}`;
  }

  if (invite.revokedAt) {
    return `iptal: ${formatDateTime(invite.revokedAt)}`;
  }

  return '';
}
