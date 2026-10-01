import {
  AdminUserDetailResponse,
  apiFetch,
  fetchOrNotFound,
  formatDate,
  formatDateTime,
  listAdminRoles,
  listAdminUserRoles,
  requireAdmin,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../../lib/api';
import { criticalPermissionsIn, effectivePermissions } from '../../../lib/permission-model';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { updateUserStatusAction } from '../actions';
import { AdminInviteLinkForm } from './admin-invite-link-form';
import { AdminRoleAssignmentCard, labelPermissions } from './role-assignment-card';
import { UserActivateConsequence, type ActivationScope } from './user-activate-consequence';

type SearchParams = {
  statusError?: string;
  /** Written by the role assign/revoke actions (app/roles/actions.ts). */
  ok?: string;
  error?: string;
};

const ROLE_OK_MESSAGES: Record<string, string> = {
  'role-assigned': 'Rol atandı.',
  'role-revoked': 'Rol geri alındı.',
};

type AdminUserDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<SearchParams>;
};

/**
 * One staff account (#50, ADMIN-DESIGN-001 Faz 3G). The design has no screen
 * for it; it is built on the detail template: a way back to the list, the
 * summary card (account kind and status, name, contact, a strip with the
 * account's state) with the status switch, then the profile, the account's
 * status, the invite link and the roles.
 *
 * Every gate is where it was:
 * - The page is ADMIN_USERS_READ.
 * - Pasifleştir / Aktifleştir is ADMIN_USERS_STATUS, and never on one's own
 *   active account. Pasifleştir now asks first; the form and its fields
 *   (`userId`, `isActive`) are unchanged.
 * - The invite link and the roles are root capabilities (RG-7 §12.1): the
 *   role lists are read, and the controls drawn, for a super admin viewer
 *   only. Anyone else gets the roles card's explanation and no invite card.
 */
export default async function AdminUserDetailPage({ params, searchParams }: AdminUserDetailPageProps) {
  const { user: actor, isSuperAdmin: isSuperAdminViewer, can } = await requireAdmin('ADMIN_USERS_READ');
  const canChangeStatus = can('ADMIN_USERS_STATUS');
  const { id } = await params;
  const search = (await searchParams) ?? {};

  // Unknown or malformed id: the 404 screen, as on every other detail.
  const response = await fetchOrNotFound(() => apiFetch<AdminUserDetailResponse>(`/users/${id}`));

  const { user, metrics } = response;
  const isSelf = actor.id === user.id;
  const isSuperAdminTarget = user.role === 'SUPER_ADMIN';
  // A super admin's status is a super admin's to change (users.service, which
  // refuses anyone else with 403); the control is not drawn for anyone else.
  const superAdminTargetLocked = isSuperAdminTarget && !isSuperAdminViewer;
  const showStatusControl = canChangeStatus && !(isSelf && user.isActive) && !superAdminTargetLocked;

  /*
   * Roles are a super admin's to hand out, so this block is fetched only for
   * one. A staff account with ADMIN_USERS_READ sees the rest of the page and
   * a line explaining why it cannot see this — better than a card that 403s on
   * every button, and better than a silent gap.
   */
  const roleState = isSuperAdminViewer
    ? await Promise.all([listAdminUserRoles(user.id), listAdminRoles()]).then(([assigned, catalogue]) => ({
        assigned,
        catalogue,
      }))
    : null;

  const displayName = user.name ?? user.email ?? user.phone ?? '—';

  // What "Hesabı aktifleştir" gives back, from the role lists a super admin
  // viewer has already read; nobody else may read them, and the dialog says so.
  const activationScope: ActivationScope =
    roleState && !roleState.assigned.isSuperAdmin
      ? (() => {
          const live = roleState.assigned.assignments.filter((assignment) => assignment.revokedAt === null);
          const effective = effectivePermissions(roleState.assigned.assignments);
          return {
            activeRoles: live
              .filter((assignment) => assignment.role.isActive)
              .map((assignment) => ({ name: assignment.role.name, permissionCount: assignment.role.permissions.length })),
            inactiveRoleCount: live.filter((assignment) => !assignment.role.isActive).length,
            permissionCount: effective.length,
            critical: labelPermissions(criticalPermissionsIn(effective)),
          };
        })()
      : null;
  const contact = [user.phone, user.email].filter(Boolean).join(' · ');

  const facts: SummaryItem[] = [
    {
      label: 'Hesap',
      value: user.isActive ? 'Aktif' : 'Pasif',
      note: user.hasPassword ? 'Şifre belirlenmiş' : 'Şifre belirlenmemiş',
      tone: user.isActive ? (user.hasPassword ? 'success' : 'warning') : 'danger',
      testId: 'user-fact-account',
    },
    {
      label: 'Aktif oturum',
      value: metrics.activeSessionCount,
      testId: 'user-fact-sessions',
    },
    {
      label: 'Son giriş',
      value: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Hiç girmedi',
    },
  ];
  if (roleState) {
    if (roleState.assigned.isSuperAdmin) {
      facts.push({ label: 'Yetki', value: 'Tüm izinler', note: 'süper yönetici; rol atanmaz' });
    } else {
      const live = roleState.assigned.assignments.filter((assignment) => assignment.revokedAt === null);
      facts.push({
        label: 'Aktif rol',
        value: live.filter((assignment) => assignment.role.isActive).length,
        note: `${effectivePermissions(roleState.assigned.assignments).length} izin`,
        testId: 'user-fact-roles',
      });
    }
  }

  return (
    <main className="system-page user-detail-page">
      <DetailHeader
        back={{ href: '/users', label: 'Yönetici hesapları' }}
        badges={
          <>
            <span className={userRoleBadgeClass(user.role)}>{userRoleLabel(user.role)}</span>
            {user.isActive ? (
              <span className="badge badge-good" data-testid="user-status">
                Aktif
              </span>
            ) : (
              <span className="badge badge-bad" data-testid="user-status">
                Pasif
              </span>
            )}
          </>
        }
        meta={<>{formatDate(user.createdAt)} tarihinden beri kayıtlı</>}
        title={displayName}
        subtitle={contact || undefined}
        actions={
          showStatusControl ? (
            <UserStatusForm
              userId={user.id}
              isActive={user.isActive}
              activeSessionCount={metrics.activeSessionCount}
              isSuperAdminTarget={isSuperAdminTarget}
              displayName={displayName}
              activationScope={activationScope}
            />
          ) : undefined
        }
        facts={facts}
        factsLabel="Hesap özeti"
        testId="user-header"
      />

      {search.statusError ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="user-status-error">
          {search.statusError}
        </div>
      ) : null}
      {search.ok && ROLE_OK_MESSAGES[search.ok] ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="role-assignment-ok">
          {ROLE_OK_MESSAGES[search.ok]}
        </div>
      ) : null}
      {search.error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="role-assignment-error">
          {search.error}
        </div>
      ) : null}

      <div className="detail-panel">
        <div className="detail-panel-grid">
          <SectionCard title="Profil ve iletişim" testId="user-profile-card">
            <KeyValueList
              items={[
                { label: 'Ad soyad', value: user.name },
                {
                  label: 'E-posta',
                  value: user.email ? (
                    <a className="cell-link cell-break" href={`mailto:${user.email}`}>
                      {user.email}
                    </a>
                  ) : null,
                },
                {
                  label: 'Telefon',
                  value: user.phone ? (
                    <a className="cell-link" href={`tel:${user.phone}`}>
                      {user.phone}
                    </a>
                  ) : null,
                },
                {
                  label: 'Hesap türü',
                  value: <span className={userRoleBadgeClass(user.role)}>{userRoleLabel(user.role)}</span>,
                },
                { label: 'Kayıt tarihi', value: formatDateTime(user.createdAt) },
                { label: 'Güncellenme', value: formatDateTime(user.updatedAt) },
                {
                  label: 'Kullanıcı ID',
                  value: (
                    <details className="muted technical-id">
                      <summary>Teknik bilgi</summary>
                      <code>{user.id}</code>
                    </details>
                  ),
                },
              ]}
            />
          </SectionCard>

          <SectionCard title="Güvenlik ve erişim" testId="user-access-card">
            <KeyValueList
              items={[
                {
                  label: 'Durum',
                  value: (
                    <>
                      {user.isActive ? (
                        <span className="badge badge-good">Aktif</span>
                      ) : (
                        <span className="badge badge-bad">Pasif</span>
                      )}
                      <div className="cell-muted" data-testid="user-status-note">
                        {superAdminTargetLocked && canChangeStatus
                          ? 'Süper yönetici hesabının durumunu yalnız bir süper yönetici değiştirebilir.'
                          : isSelf
                          ? 'Kendi hesabınızı pasifleştiremezsiniz.'
                          : user.isActive
                            ? 'Pasif kullanıcılar giriş yapamaz.'
                            : 'Aktifleştirilen kullanıcı yeniden giriş yapabilir.'}
                      </div>
                    </>
                  ),
                },
                {
                  label: 'Şifre',
                  value: user.hasPassword ? (
                    <span className="badge badge-good">Şifre var</span>
                  ) : (
                    <span className="badge badge-warn">Şifre yok</span>
                  ),
                },
                { label: 'Aktif oturum', value: String(metrics.activeSessionCount) },
                { label: 'Son giriş', value: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Hiç girmedi' },
              ]}
            />
            <p className="detail-muted-note">
              Hesabın rol türü değiştirilemez: personel hesabı personel, hizmet veren hesabı hizmet veren olarak kalır.
              Yetki, atanan rollerden gelir.
            </p>
          </SectionCard>

          {/*
            Minting an invite link is root-only (`POST /users/:id/invite-link`,
            RG-7 §12.1). The card is rendered for a super admin viewer only.
          */}
          {isSuperAdminViewer ? <AdminInviteSection user={user} /> : null}

          <AdminRoleAssignmentCard
            isSuperAdminViewer={isSuperAdminViewer}
            roles={roleState}
            userId={user.id}
            accountName={displayName}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * Both directions ask first. Pasifleştir says what `PATCH /users/:id/status`
 * and the session read do (users.service `updateStatus`, auth.service): the
 * sign-in and every open session are refused from the next request, nothing is
 * deleted. Aktifleştir says the other half of that — nothing was deleted, so
 * the account comes back with all of it, a super admin with everything
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 */
function UserStatusForm({
  userId,
  isActive,
  activeSessionCount,
  isSuperAdminTarget,
  displayName,
  activationScope,
}: {
  userId: string;
  isActive: boolean;
  activeSessionCount: number;
  isSuperAdminTarget: boolean;
  displayName: string;
  activationScope: ActivationScope;
}) {
  return (
    <form action={updateUserStatusAction} className="inline-form" data-testid="user-status-form">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      {isActive ? (
        <ConfirmDialog
          triggerLabel="Hesabı pasifleştir"
          title="Hesap pasifleştirilsin mi?"
          consequence={
            <>
              <p data-testid="user-deactivate-impact">
                Kullanıcı bir daha giriş yapamaz.{' '}
                {activeSessionCount > 0
                  ? `${activeSessionCount} açık oturumu bir sonraki isteğinde reddedilir.`
                  : 'Şu an açık oturumu yok.'}
              </p>
              <p>
                Rol atamaları, şifresi ve kayıtları silinmez; hesap buradan yeniden aktifleştirildiğinde aynı yetkilerle
                döner.
                {isSuperAdminTarget ? ' Son aktif süper yönetici pasifleştirilemez; API bu durumda isteği reddeder.' : ''}
              </p>
            </>
          }
          confirmLabel="Evet, pasifleştir"
          testId="user-deactivate"
        />
      ) : (
        <ConfirmDialog
          triggerLabel="Hesabı aktifleştir"
          triggerClassName="btn btn-primary"
          tone="primary"
          title={isSuperAdminTarget ? 'Süper yönetici hesabı aktifleştirilsin mi?' : 'Hesap aktifleştirilsin mi?'}
          consequence={
            <UserActivateConsequence
              displayName={displayName}
              isSuperAdminTarget={isSuperAdminTarget}
              scope={activationScope}
            />
          }
          confirmLabel="Evet, aktifleştir"
          testId="user-activate"
        />
      )}
    </form>
  );
}

function AdminInviteSection({ user }: { user: AdminUserDetailResponse['user'] }) {
  // Both staff kinds: the API regenerates a link for an ADMIN (every account
  // `POST /users` has made since PR-0) as well as for a SUPER_ADMIN. The card
  // used to render for SUPER_ADMIN targets only, so an ADMIN whose first link
  // expired had no way to get a second one from this screen.
  if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
    return null;
  }

  return (
    <SectionCard title="Admin daveti" testId="user-invite-card">
      {user.hasPassword ? (
        <p className="detail-muted-note">
          Bu admin kullanıcısı şifresini belirlemiş; yeni davet bağlantısı oluşturulmasına gerek yok.
        </p>
      ) : !user.isActive ? (
        <p className="detail-muted-note">
          Pasif admin kullanıcısı için davet bağlantısı oluşturulamaz. Önce kullanıcıyı aktifleştirin.
        </p>
      ) : (
        <>
          <p className="detail-muted-note">
            Bu admin kullanıcısı henüz şifre belirlememiş. Şifre belirleme bağlantısı oluşturabilir ve manuel olarak
            paylaşabilirsiniz. Yeni bir bağlantı oluşturulduğunda önceki kullanılmamış bağlantılar geçersiz olur.
          </p>
          <AdminInviteLinkForm userId={user.id} />
        </>
      )}
    </SectionCard>
  );
}
