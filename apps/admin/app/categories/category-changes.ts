import type { Category, CategoryKind, CategoryStatus } from '../../lib/api';
import type { ConfirmationProofKey } from '../../lib/confirmation-proof-keys';

/**
 * What a category save sends, and which of its changes ask first
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B) — one module for the save
 * buttons, which ask when they find a change, and for the server actions,
 * which demand the same proofs when they find the same change against the
 * category they have just read from the API. The form's own word ("nothing
 * changed") is never asked.
 *
 * Kept free of server-only imports so the client buttons can use it, and out
 * of `actions.ts` because a `'use server'` file may export only async
 * functions.
 */

/** The PATCH/POST body the category form produces — exactly what the API receives. */
export type CategoryPayload = {
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  coverImageUrl: string | null;
  iconKey: string | null;
  parentId: string | null;
  kind: CategoryKind;
  status?: CategoryStatus;
  sortOrder: number;
  offerCreditCost?: number;
  providerEnrollmentOpen?: boolean;
  unlimitedPackageEligible?: boolean;
};

export function categoryPayload(formData: FormData): CategoryPayload {
  const kind = readFormString(formData, 'kind') as CategoryKind;
  const status = readFormString(formData, 'status') as CategoryStatus;

  return {
    name: readFormString(formData, 'name'),
    slug: readFormString(formData, 'slug'),
    description: readOptionalFormString(formData, 'description'),
    imageUrl: readOptionalFormString(formData, 'imageUrl'),
    coverImageUrl: readOptionalFormString(formData, 'coverImageUrl'),
    iconKey: readOptionalFormString(formData, 'iconKey'),
    // Empty means "top level"; the API refuses a parent that is not a GROUP.
    parentId: readOptionalFormString(formData, 'parentId'),
    kind,
    // Not sent when the form had no status control (no CATEGORIES_STATUS):
    // the status is then left as stored rather than echoed back.
    ...(readFormString(formData, 'statusLocked') === '1' ? {} : { status }),
    sortOrder: readFormNumber(formData, 'sortOrder'),
    // Mandatory for a service, and only for a service. A group is a folder and
    // a router is a question — neither can ever be offered on, so neither has a
    // price, and sending one would be a number nothing reads. Sent as a number
    // so the API DTO's @IsInt/@Min(1) rejects empty, zero, negative and
    // non-numeric input rather than the value silently becoming null.
    ...(kind === 'LEAF' ? { offerCreditCost: readFormNumber(formData, 'offerCreditCost') } : {}),
    // Only sent where the API will take it. A live service is always open to
    // applications and refuses the field, so sending it there would turn every
    // unrelated edit of a released category into a 400. `kind` and `status` come
    // off this same form, so the condition is asked of the category the save
    // produces — which is the row the API judges too.
    //
    // An unticked checkbox never reaches FormData at all, so the comparison
    // below is how closing the switch is expressed.
    ...(kind === 'LEAF' && status === 'DRAFT'
      ? { providerEnrollmentOpen: readFormString(formData, 'providerEnrollmentOpen') === 'on' }
      : {}),
    // Sent whenever the form could carry it. A closed category renders the box
    // disabled, and a disabled input never reaches FormData — so sending the
    // field there would read as "untick it" and silently clear a flag nobody
    // touched.
    ...(status === 'INACTIVE'
      ? {}
      : {
          unlimitedPackageEligible: readFormString(formData, 'unlimitedPackageEligible') === 'on',
        }),
  };
}

/** The stored fields a save is judged against. */
export type CategoryStored = Pick<
  Category,
  'id' | 'name' | 'slug' | 'kind' | 'status' | 'parentId' | 'offerCreditCost' | 'unlimitedPackageEligible'
>;

export type CategoryChanges = {
  slug: { from: string; to: string } | null;
  kind: { from: CategoryKind; to: CategoryKind } | null;
  parent: { from: string | null; to: string | null } | null;
  status: { from: CategoryStatus; to: CategoryStatus } | null;
  offerCreditCost: { from: number | null; to: number } | null;
  /** Only the switch going on asks; switching it off goes straight through. */
  unlimitedEnable: boolean;
};

/**
 * The risky part of a save, compared the way `CategoriesService.updateCategory`
 * compares it: trimmed strings, a field the payload does not carry is not a
 * change, a value sent back unchanged is not a change.
 */
export function categoryChanges(stored: CategoryStored, payload: CategoryPayload): CategoryChanges {
  const slug = payload.slug.trim();
  const status = payload.status !== undefined && payload.status !== stored.status ? payload.status : null;
  return {
    slug: slug !== stored.slug ? { from: stored.slug, to: slug } : null,
    kind: payload.kind !== stored.kind ? { from: stored.kind, to: payload.kind } : null,
    parent:
      (payload.parentId ?? null) !== (stored.parentId ?? null)
        ? { from: stored.parentId ?? null, to: payload.parentId ?? null }
        : null,
    status: status ? { from: stored.status, to: status } : null,
    offerCreditCost:
      payload.offerCreditCost !== undefined && payload.offerCreditCost !== stored.offerCreditCost
        ? { from: stored.offerCreditCost, to: payload.offerCreditCost }
        : null,
    unlimitedEnable: payload.unlimitedPackageEligible === true && !stored.unlimitedPackageEligible,
  };
}

/** The proof a status move asks for: into ACTIVE, or out of it / between the closed ones. */
export function categoryStatusProofKey(to: CategoryStatus): ConfirmationProofKey {
  return to === 'ACTIVE' ? 'category.activate' : 'category.deactivate';
}

/** One proof per guarded change; an empty list means the save asks nothing. */
export function categoryProofKeys(changes: CategoryChanges): ConfirmationProofKey[] {
  const keys: ConfirmationProofKey[] = [];
  if (changes.slug || changes.kind || changes.parent) keys.push('category.structure-update');
  if (changes.offerCreditCost) keys.push('category.offer-credit-update');
  if (changes.unlimitedEnable) keys.push('category.unlimited-enable');
  if (changes.status) keys.push(categoryStatusProofKey(changes.status.to));
  return keys;
}

/**
 * Whether a new category is created into a status that publishes or closes
 * it. Anything but an explicit DRAFT asks — a create naming no status means
 * ACTIVE at the API.
 */
export function categoryCreateNeedsProof(payload: CategoryPayload): boolean {
  return payload.status !== 'DRAFT';
}

/**
 * The vitrin runs a status move touches, counted from the placements the API
 * lists — or null when this session may not read placements or the read
 * failed; the dialog then says it cannot count, it never guesses.
 *
 * `onAir` is what closing would suspend (ACTIVE runs of this category);
 * `heldByClosure` is what opening would resume (runs suspended with
 * CATEGORY_CLOSED).
 */
export type CategoryPlacementImpact = { onAir: number; heldByClosure: number } | null;

/** One option → service pair as the router form posts it; an empty target means none. */
export type RouterRuleEntry = { optionKey: string; targetSlug: string | null };

export function readRouterRules(formData: FormData): RouterRuleEntry[] {
  const optionKeys = formData.getAll('routerOptionKey');
  const targets = formData.getAll('routerTargetSlug');
  return optionKeys.flatMap((optionKey, index) => {
    if (typeof optionKey !== 'string') return [];
    const target = targets[index];
    const slug = typeof target === 'string' ? target.trim() : '';
    return [{ optionKey, targetSlug: slug === '' ? null : slug }];
  });
}

export type RouterRuleChange = { optionKey: string; from: string | null; to: string | null };

/**
 * Where a router save sends customers differently from the stored map
 * (`PUT /questions/:id/router-rules` replaces the whole map): a new, moved or
 * removed target per option, and a stored rule for an option the form no
 * longer carries (it would be dropped).
 */
export function routerRuleChanges(
  stored: ReadonlyArray<{ optionKey: string; targetCategorySlug: string }>,
  posted: RouterRuleEntry[],
): RouterRuleChange[] {
  const before = new Map(stored.map((rule) => [rule.optionKey, rule.targetCategorySlug]));
  const changes: RouterRuleChange[] = [];
  const seen = new Set<string>();
  for (const entry of posted) {
    seen.add(entry.optionKey);
    const from = before.get(entry.optionKey) ?? null;
    if (from !== entry.targetSlug) changes.push({ optionKey: entry.optionKey, from, to: entry.targetSlug });
  }
  for (const [optionKey, from] of before) {
    if (!seen.has(optionKey)) changes.push({ optionKey, from, to: null });
  }
  return changes;
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readOptionalFormString(formData: FormData, key: string) {
  const value = readFormString(formData, key).trim();
  return value ? value : null;
}

function readFormNumber(formData: FormData, key: string) {
  const value = Number(readFormString(formData, key));
  return Number.isFinite(value) ? value : 0;
}
