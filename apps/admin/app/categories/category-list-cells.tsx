import type { Category } from '../../lib/api';
import { formatCount } from '../../lib/pagination';
import { RELEASE_BLOCKER_HINTS, RELEASE_BLOCKER_LABELS, type ReleaseBlocker } from './category-taxonomy';

/**
 * The pieces of the category list (ADMIN-DESIGN-001 Faz 3F) that decide
 * something on their own, apart from the page so they can be checked without
 * a session.
 */

/**
 * The design's ⓘ, corrected against the code:
 *
 * - "Yayına hazır" does not ask for questions — an empty question set is a real
 *   service (`releaseBlockers`) — and it is advice: nothing refuses a status
 *   change because of it. What hides a category from customers is its status.
 * - Closing a category also stops its vitrin runs, with their clock stopped
 *   (`CategoriesService.applyStatusChange`).
 */
export const CATEGORIES_SCREEN_INFO =
  'Müşterinin talep oluştururken seçtiği hizmet ağacı: gruplar, talep alan hizmetler ve müşteriyi tek soruyla doğru hizmete taşıyan yönlendiriciler. Her hizmetin kendi form soruları ve teklif kredisi vardır; teklif kredisi, o hizmette bir teklif vermenin kaç krediye mal olduğudur. Müşteri yalnız "Yayında" durumundaki kategorileri görür; taslaklar yalnız bu panelde görünür, kapatılan kategori yeni talep almaz ve vitrin yayınları süresi durdurularak askıya alınır. "Yayına hazır mı?" bir kontrol listesidir, durumu sizin yerinize değiştirmez: hazır sayılmak için hizmetin teklif kredisi tanımlı ve en az bir onaylı hizmet vereni olmalı, düzenlemeye tabi hizmetler ayrıca incelenmelidir. Soru seti zorunlu değildir.';

/**
 * The design's second line under a category's name: where a child hangs
 * ("Isıtma ve soğutma altında") and how much hangs under a group ("Üst grup ·
 * 4 hizmet" — here "N alt kategori", because the count is of every kind).
 */
export function treeRowContext(category: Category, byId: ReadonlyMap<string, Category>): string | null {
  const parts: string[] = [];
  if (category.parentId) {
    const parent = byId.get(category.parentId);
    parts.push(parent ? `${parent.name} altında` : 'üst kategorisi listede yok');
  }
  if (category.kind === 'GROUP') {
    const children = category._count?.children ?? 0;
    parts.push(children === 0 ? 'alt kategori yok' : `${formatCount(children)} alt kategori`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The verdict: "Hazır", or "Hazır değil" with every reason.
 *
 * `explain` adds each reason's sentence and the per-blocker test ids — the
 * release checklist's wording, which reads its rows in a release meeting. The
 * tree gives the labels only. The reason is in the cell itself, never only in
 * a title attribute: a keyboard, a phone and a screenshot do not see those.
 */
export function TreeReadiness({ blockers, explain = false }: { blockers: ReleaseBlocker[]; explain?: boolean }) {
  if (blockers.length === 0) {
    return <span className="badge badge-good">Hazır</span>;
  }

  return (
    <span className="release-blocker-list">
      <span className="badge badge-warn">Hazır değil</span>
      {blockers.map((blocker) =>
        explain ? (
          <span className="cell-muted" data-testid={`release-blocker-${blocker}`} key={blocker}>
            <strong>{RELEASE_BLOCKER_LABELS[blocker]}.</strong> {RELEASE_BLOCKER_HINTS[blocker]}
          </span>
        ) : (
          <span className="cell-muted" key={blocker}>
            {RELEASE_BLOCKER_LABELS[blocker]}
          </span>
        ),
      )}
    </span>
  );
}
