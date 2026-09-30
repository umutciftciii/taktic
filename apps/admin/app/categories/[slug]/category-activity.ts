import { recordLifecycleEntries, type ActivityEntry } from '../../../components/activity-log';
import type { Category, ProviderInvite, Question } from '../../../lib/api';

/**
 * A category's "Neler oldu" (ADMIN-DESIGN-001 Faz 3F.1), built from the
 * instants its own rows carry and nothing else:
 *
 * - the category's creation and its last save (`createdAt` / `updatedAt`);
 * - each question's creation and last save — only when the session may read
 *   questions, because the list comes from that read;
 * - each invitation: issued (by whom, when the row names them), used,
 *   withdrawn, or run out — only when the invitation history was read.
 *
 * There is no change log for categories or questions, so no entry claims to
 * know what changed or who changed it; the screen's footnote says so.
 */
export function categoryActivity({
  category,
  questions,
  invites,
}: {
  category: Category;
  /** `null` without QUESTIONS_READ. */
  questions: Question[] | null;
  /** `null` when the invitation history is not read on this screen. */
  invites: ProviderInvite[] | null;
}): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  if (category.createdAt && category.updatedAt) {
    entries.push(
      ...recordLifecycleEntries({
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        created: 'Kategori oluşturuldu',
        updated: 'Kategori son güncellendi',
      }).map((entry) => ({ ...entry, key: `category-${entry.key}` })),
    );
  }

  for (const question of questions ?? []) {
    if (!question.createdAt || !question.updatedAt) continue;
    entries.push(
      ...recordLifecycleEntries({
        createdAt: question.createdAt,
        updatedAt: question.updatedAt,
        created: `"${question.label}" sorusu eklendi`,
        updated: `"${question.label}" sorusu son güncellendi`,
      }).map((entry) => ({ ...entry, key: `question-${question.id}-${entry.key}` })),
    );
  }

  for (const invite of invites ?? []) {
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
        actor: null,
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
