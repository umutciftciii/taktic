import type { Category, CategoryKind, CategoryStatus } from '../../lib/api';

/**
 * The words the admin app uses for the taxonomy, in one place, plus the small
 * amount of arithmetic the category screens do over a flat list.
 *
 * Nothing here decides anything: every rule it describes is enforced by the
 * API. This is the vocabulary the screens explain those rules in.
 */

export const CATEGORY_KINDS: CategoryKind[] = ['GROUP', 'LEAF', 'ROUTER'];
export const CATEGORY_STATUSES: CategoryStatus[] = ['DRAFT', 'ACTIVE', 'INACTIVE'];

export const KIND_LABELS: Record<CategoryKind, string> = {
  GROUP: 'Grup',
  LEAF: 'Hizmet',
  ROUTER: 'Yönlendirici',
};

export const KIND_HINTS: Record<CategoryKind, string> = {
  GROUP: 'Yalnızca alt kategorileri toplar. Talep almaz, hizmet verene atanamaz.',
  LEAF: 'Talep alan gerçek hizmet. Eşleştirme, teklif ve kredi bu tip üzerinden çalışır.',
  ROUTER:
    'Tek bir soruyla müşteriyi doğru hizmete taşır. Kendisi talep almaz ve hizmet verene atanamaz.',
};

export const STATUS_LABELS: Record<CategoryStatus, string> = {
  DRAFT: 'Taslak',
  ACTIVE: 'Yayında',
  INACTIVE: 'Kapalı',
};

export const STATUS_HINTS: Record<CategoryStatus, string> = {
  DRAFT:
    'Yalnızca bu panelde görünür. Müşteri kataloğunda ve hizmet veren keşfinde yer almaz, yeni talep yalnızca yönetici tarafından açılabilir.',
  ACTIVE: 'Müşteri kataloğunda listelenir, talep alır ve hizmet verenlerle eşleşir.',
  INACTIVE:
    'Yeni talep ve yeni hizmet veren seçimi kapalıdır. Geçmiş talepler, teklifler ve cevaplar okunmaya devam eder.',
};

/**
 * What stands between a draft service and the catalogue.
 *
 * Two things, and deliberately only two, because each of them makes a released
 * category *silently* broken rather than visibly wrong:
 *
 *   price missing        A provider is charged per offer, and a category with
 *                        no price refuses every offer. The category would look
 *                        live and take requests no one could answer.
 *   no approved provider The request would be published to an empty room. A
 *                        pending or suspended profile does not count — neither
 *                        is ever shown a request.
 *
 * An empty question set is *not* on the list. A service whose base form is
 * enough is a real thing — several of the founding categories are exactly that
 * — so the question count is shown as information and never as a verdict.
 *
 * Only services can be released in this sense. A group is a folder and a router
 * is a question; neither takes a request or carries a price.
 */
export type ReleaseBlocker = 'NO_PRICE' | 'NO_APPROVED_PROVIDER';

export const RELEASE_BLOCKER_LABELS: Record<ReleaseBlocker, string> = {
  NO_PRICE: 'Teklif kredisi tanımsız',
  NO_APPROVED_PROVIDER: 'Onaylı hizmet veren yok',
};

export const RELEASE_BLOCKER_HINTS: Record<ReleaseBlocker, string> = {
  NO_PRICE:
    'Teklif kredisi tanımlı olmayan bir kategoride hizmet veren teklif veremez. Yayına alınırsa talep alır ama hiçbir teklif ulaşmaz.',
  NO_APPROVED_PROVIDER:
    'Bu kategoriye bağlı onaylı hizmet veren yok. Yayına alınırsa açılan talepler kimseye ulaşmaz.',
};

export function releaseBlockers(category: Category): ReleaseBlocker[] {
  if (category.kind !== 'LEAF') return [];

  const blockers: ReleaseBlocker[] = [];
  if (category.offerCreditCost === null) blockers.push('NO_PRICE');
  if ((category._count?.providers ?? 0) === 0) blockers.push('NO_APPROVED_PROVIDER');
  return blockers;
}

export function isReleaseReady(category: Category): boolean {
  return category.kind === 'LEAF' && releaseBlockers(category).length === 0;
}

/**
 * The drafts a release checklist is about: services, not the groups they hang
 * under. A group carries no price, no provider and no request — releasing one
 * is bookkeeping, and putting five of them on the checklist would bury the
 * fifteen rows somebody actually has to act on.
 */
export function draftServices(categories: readonly Category[]): Category[] {
  return categories.filter(
    (category) => category.status === 'DRAFT' && category.kind === 'LEAF',
  );
}

export function statusBadgeClass(status: CategoryStatus): string {
  if (status === 'ACTIVE') return 'badge badge-good';
  if (status === 'DRAFT') return 'badge badge-warn';
  return 'badge badge-muted';
}

/**
 * A flat list, ordered so children follow their parent.
 *
 * The API returns categories in sort order without a tree, because a tree is a
 * rendering concern and one query is cheaper than N. `depth` is what the table
 * indents by.
 */
export type TreeRow = { category: Category; depth: number };

export function toTreeRows(categories: readonly Category[]): TreeRow[] {
  const childrenOf = new Map<string | null, Category[]>();

  for (const category of categories) {
    const key = category.parentId ?? null;
    const bucket = childrenOf.get(key);
    if (bucket) {
      bucket.push(category);
    } else {
      childrenOf.set(key, [category]);
    }
  }

  const known = new Set(categories.map((category) => category.id));
  const rows: TreeRow[] = [];

  const walk = (parentId: string | null, depth: number) => {
    for (const category of childrenOf.get(parentId) ?? []) {
      rows.push({ category, depth });
      walk(category.id, depth + 1);
    }
  };

  walk(null, 0);

  // A category whose parent was filtered out of the list still has to appear —
  // a row nobody can see is a row nobody can fix.
  for (const category of categories) {
    if (category.parentId && !known.has(category.parentId)) {
      rows.push({ category, depth: 0 });
    }
  }

  return rows;
}
