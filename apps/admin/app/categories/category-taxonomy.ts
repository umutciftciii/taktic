import type {
  Category,
  CategoryKind,
  CategoryStatus,
  CategorySupplyStatus,
  IssuedProviderInvite,
  ProviderInviteState,
} from '../../lib/api';

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
 * The supply question, in words.
 *
 * Deliberately a different sentence from the release verdict below, and shown
 * beside it rather than merged into it. They answer different questions — "is
 * there anybody behind this" and "may this be published" — and a category can
 * have its providers and still be unreleasable for want of a price. One badge
 * for both would hide exactly that row, which is the one somebody has to act on
 * differently.
 */
export const SUPPLY_STATUS_LABELS: Record<CategorySupplyStatus, string> = {
  EMPTY: 'Onaylı hizmet veren bekleniyor',
  SUPPLY_READY: 'Hizmet veren hazır · teklif kredisi tanımlanmalı',
  LAUNCH_READY: 'Yayına hazır',
  LIVE: 'Yayında',
};

export function supplyStatusBadgeClass(status: CategorySupplyStatus): string {
  if (status === 'LIVE' || status === 'LAUNCH_READY') return 'badge badge-good';
  if (status === 'SUPPLY_READY') return 'badge badge-warn';
  return 'badge badge-muted';
}

/**
 * What the enrollment switch adds to the supply sentence.
 *
 * `null` when there is nothing to add: a live service is always open, so saying
 * so on every row would be noise. A closed draft is the case worth a line,
 * because "nobody has applied" and "nobody may apply" look identical in the
 * count and are entirely different problems.
 */
export function enrollmentSentence(category: Category): string | null {
  if (category.kind !== 'LEAF' || category.status !== 'DRAFT') return null;
  if (!category.providerEnrollmentOpen) return 'Yeni hizmet veren başvurusu kapalı';
  if (category.supplyStatus === 'EMPTY') return 'Başvuruya açık, onaylı hizmet veren bekleniyor';
  return 'Başvuruya açık';
}

/**
 * The services whose release needs a decision nothing in the database can make.
 *
 * Two of the second expansion wave's categories sit in regulated work: who may
 * perform it, and how it may be advertised, are questions with legal answers
 * rather than operational ones. Both are perfectly fine as drafts — a draft is
 * invisible to customers and to provider discovery — but neither may be put on
 * the catalogue on the strength of a price and a headcount alone.
 *
 * A list of slugs in the admin app, and deliberately not a column on the
 * category. The warning is a note to the operator standing in front of the
 * status switch; it is not a property of the service, it has no reader outside
 * this panel, and keeping it here means there is no field for the public
 * catalogue, the provider surfaces or an API response to leak. The API never
 * learns this list exists.
 *
 * Adding a slug here is how a future wave's regulated service inherits the
 * same warning. Removing one is how a completed eligibility review is
 * recorded — which is a code change on purpose, because "we checked" is a
 * claim somebody should have to sign.
 */
const ELIGIBILITY_REVIEW_SLUGS = new Set<string>(['beslenme-danismanligi', 'isg-danismanligi']);

export function needsEligibilityReview(category: Category): boolean {
  return category.kind === 'LEAF' && ELIGIBILITY_REVIEW_SLUGS.has(category.slug);
}

/**
 * What stands between a draft service and the catalogue.
 *
 * Three things, and deliberately only three, because each of them makes a
 * released category broken in a way nobody would notice from the outside:
 *
 *   price missing        A provider is charged per offer, and a category with
 *                        no price refuses every offer. The category would look
 *                        live and take requests no one could answer.
 *   no approved provider The request would be published to an empty room. A
 *                        pending or suspended profile does not count — neither
 *                        is ever shown a request.
 *   eligibility unclear  The work is regulated. Releasing it would put the
 *                        marketplace in front of customers for a service whose
 *                        providers have not been checked against the rules that
 *                        govern who may perform it.
 *
 * An empty question set is *not* on the list. A service whose base form is
 * enough is a real thing — several of the founding categories are exactly that
 * — so the question count is shown as information and never as a verdict.
 *
 * Only services can be released in this sense. A group is a folder and a router
 * is a question; neither takes a request or carries a price.
 */
export type ReleaseBlocker = 'NO_PRICE' | 'NO_APPROVED_PROVIDER' | 'NEEDS_ELIGIBILITY_REVIEW';

export const RELEASE_BLOCKER_LABELS: Record<ReleaseBlocker, string> = {
  NO_PRICE: 'Teklif kredisi tanımsız',
  NO_APPROVED_PROVIDER: 'Onaylı hizmet veren yok',
  NEEDS_ELIGIBILITY_REVIEW: 'Ek uygunluk incelemesi gerekir',
};

export const RELEASE_BLOCKER_HINTS: Record<ReleaseBlocker, string> = {
  NO_PRICE:
    'Teklif kredisi tanımlı olmayan bir kategoride hizmet veren teklif veremez. Yayına alınırsa talep alır ama hiçbir teklif ulaşmaz.',
  NO_APPROVED_PROVIDER:
    'Bu kategoriye bağlı onaylı hizmet veren yok. Yayına alınırsa açılan talepler kimseye ulaşmaz.',
  NEEDS_ELIGIBILITY_REVIEW:
    'Bu hizmet düzenlemeye tabi bir alanda. Yayına almadan önce hizmet verenlerin mesleki yeterliliği ve belge durumu ayrıca incelenmelidir. Bu not yalnız bu panelde görünür.',
};

export function releaseBlockers(category: Category): ReleaseBlocker[] {
  if (category.kind !== 'LEAF') return [];

  const blockers: ReleaseBlocker[] = [];
  if (category.offerCreditCost === null) blockers.push('NO_PRICE');
  if ((category._count?.providers ?? 0) === 0) blockers.push('NO_APPROVED_PROVIDER');
  if (needsEligibilityReview(category)) blockers.push('NEEDS_ELIGIBILITY_REVIEW');
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

/**
 * The words the invitation panel uses for a link's state.
 *
 * They live here rather than in lib/api.ts for a mechanical reason worth
 * knowing: that module reads `next/headers`, so importing a *value* from it
 * into a client component pulls server-only code into the browser bundle and
 * the build refuses it. Types are erased and travel fine; constants and
 * functions belong in this file, with the rest of the admin app's vocabulary.
 */
export const PROVIDER_INVITE_STATE_LABELS: Record<ProviderInviteState, string> = {
  ACTIVE: 'Geçerli',
  USED: 'Kullanıldı',
  REVOKED: 'İptal edildi',
  EXPIRED: 'Süresi doldu',
};

export function providerInviteStateBadgeClass(state: ProviderInviteState): string {
  if (state === 'ACTIVE') return 'badge badge-good';
  // Spent is not a failure — somebody applied, which is what the link was for.
  if (state === 'USED') return 'badge badge-muted';
  return 'badge badge-warn';
}

/**
 * What the invitation panel renders after an operator presses a button.
 *
 * A discriminated result rather than a redirect, and that is the whole reason
 * the actions behind it return one. The successful issue carries the link, and
 * the link is the credential: putting it in a redirect URL would write it into
 * browser history, into the `Referer` of every asset the next page loads and
 * into every access log between the server and the browser. Handing it back as
 * the form's *result* keeps it in one server-rendered response — visible once,
 * gone on the next navigation, and unrecoverable by refreshing, because no
 * endpoint can produce it again.
 *
 * Here rather than beside the actions for the same bundling reason as above: a
 * `'use server'` module may export nothing but async functions, so its initial
 * state cannot live there.
 */
export type ProviderInviteFormState =
  | { kind: 'idle' }
  | { kind: 'issued'; invite: IssuedProviderInvite }
  | { kind: 'revoked'; alreadyDead: boolean }
  | { kind: 'error'; message: string };

export const PROVIDER_INVITE_IDLE: ProviderInviteFormState = { kind: 'idle' };
