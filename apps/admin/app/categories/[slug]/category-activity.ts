import type { ActivityEntry } from '../../../components/activity-log';
import type { ProviderInvite } from '../../../lib/api';

/**
 * A category's invitation history, from the instants and the operators the
 * invitation rows record (ADMIN-ACTION-AUDIT-001):
 *
 * - issued, by whom when the row names them;
 * - used, by the applying business;
 * - withdrawn, by the operator `revokedBy` names — or "Bilinmiyor" for a link
 *   withdrawn before the withdrawing operator was recorded;
 * - run out, by the clock.
 *
 * The category's own changes are not built here any more: they come from the
 * catalogue audit (`GET /admin/categories/:slug/history`), with their field
 * diffs and their operators, instead of the record's `createdAt`/`updatedAt`.
 */
export function inviteActivity(invites: ProviderInvite[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const invite of invites) {
    entries.push({
      key: `invite-${invite.id}-issued`,
      at: invite.createdAt,
      title: 'Davet bağlantısı oluşturuldu',
      actor: invite.createdBy?.name ?? null,
    });
    if (invite.usedAt) {
      entries.push({
        key: `invite-${invite.id}-used`,
        at: invite.usedAt,
        title: 'Davet bağlantısı kullanıldı',
        note: 'Bir işletme bu bağlantıyla başvuru gönderdi.',
        actor: 'Başvuran işletme',
      });
    }
    if (invite.revokedAt) {
      entries.push({
        key: `invite-${invite.id}-revoked`,
        at: invite.revokedAt,
        title: 'Davet bağlantısı iptal edildi',
        actor: invite.revokedBy ? (invite.revokedBy.name ?? `Hesap #${invite.revokedBy.id}`) : 'Bilinmiyor',
      });
    }
    if (invite.state === 'EXPIRED') {
      entries.push({
        key: `invite-${invite.id}-expired`,
        at: invite.expiresAt,
        title: 'Davet bağlantısının süresi doldu',
        actor: 'Otomatik',
      });
    }
  }

  return entries;
}
