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
