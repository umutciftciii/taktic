'use server';

import { parseTurkishLiraToMinor } from '@taktic/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch, type ShowcasePackage } from '../../../lib/api';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import type { ConfirmationProofKey } from '../../../lib/confirmation-proof-keys';
import { hasConfirmationProof, hasConfirmationProofs } from '../../../lib/confirmation-proof-server';
import { readShowcaseTerms, showcasePackageTermsChanges } from './package-changes';

/**
 * Maintaining the vitrin catalogue.
 *
 * ## Why the slug is only ever written at creation
 *
 * It is the key into `LEMON_SQUEEZY_VARIANT_MAP`, which decides which payment
 * variant may stand for which product. Renaming a slug detaches every future
 * checkout for that package from the variant it was mapped to, and the failure
 * surfaces at the worst possible moment: a provider who has paid, and a
 * settlement refused with `VARIANT_MISMATCH`.
 *
 * So there is no rename here and none in the API. Retiring a package
 * (`isActive: false`) and creating its replacement is the safe shape, and it
 * leaves every purchase made under the old one readable.
 *
 * ## What editing a package does not do
 *
 * It does not change anything already sold. Price, duration and area cap are
 * snapshotted onto the purchase and again onto the placement, and no run ever
 * reads this catalogue back — the same contract the offer packages already
 * hold.
 */
export async function createShowcasePackageAction(formData: FormData) {
  // The form speaks lira; the API stores kuruş. The shared parser is the one
  // place the two meet, and a value it refuses never reaches the API.
  const priceAmount = parseTurkishLiraToMinor(readString(formData, 'priceAmount'));
  if (priceAmount === null) {
    redirect(failureHref(NEW_PACKAGE_KEY, 'SHOWCASE_PACKAGE_PRICE_INVALID'));
  }
  // A new package is on sale the moment it exists (the API creates it
  // active), and its slug can never change: asked in a dialog, whose proof is
  // checked before anything is sent (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
  if (!(await hasConfirmationProof(formData, 'showcase-package.create-active'))) {
    redirect(failureHref(NEW_PACKAGE_KEY, CONFIRMATION_REQUIRED));
  }

  try {
    await apiFetch('/admin/showcase/packages', {
      method: 'POST',
      body: JSON.stringify({
        name: readString(formData, 'name'),
        slug: readString(formData, 'slug'),
        priceAmount,
        durationDays: readInt(formData, 'durationDays'),
        activationWindowDays: readInt(formData, 'activationWindowDays'),
        allowedCardKind: readOptional(formData, 'allowedCardKind'),
        maxAreas: readOptionalInt(formData, 'maxAreas'),
        description: readOptional(formData, 'description'),
        sortOrder: readOptionalInt(formData, 'sortOrder') ?? 0,
      }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(failureHref(NEW_PACKAGE_KEY, errorCode(error)));
  }

  revalidatePath('/showcase/packages');
  redirect('/showcase/packages?created=1');
}

export async function updateShowcasePackageAction(formData: FormData) {
  const packageId = readString(formData, 'packageId');
  const priceAmount = parseTurkishLiraToMinor(readString(formData, 'priceAmount'));
  if (priceAmount === null) {
    redirect(failureHref(packageId, 'SHOWCASE_PACKAGE_PRICE_INVALID'));
  }
  // What this save changes is judged against the package as the API has it
  // now, never on the form's word: a change to what a purchase buys needs
  // `showcase-package.update-commercial`, "Durum" moved needs the header
  // button's proof. A save of the name, description or order needs none.
  const required = await requiredEditProofs(packageId, formData);
  if (required.length > 0 && !(await hasConfirmationProofs(formData, required))) {
    redirect(failureHref(packageId, CONFIRMATION_REQUIRED));
  }

  try {
    await apiFetch(`/admin/showcase/packages/${packageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: readString(formData, 'name'),
        priceAmount,
        durationDays: readInt(formData, 'durationDays'),
        activationWindowDays: readInt(formData, 'activationWindowDays'),
        allowedCardKind: readOptional(formData, 'allowedCardKind'),
        maxAreas: readOptionalInt(formData, 'maxAreas'),
        description: readOptional(formData, 'description'),
        isActive: formData.get('isActive') === 'on',
        sortOrder: readOptionalInt(formData, 'sortOrder') ?? 0,
      }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(failureHref(packageId, errorCode(error)));
  }

  revalidatePath('/showcase/packages');
  revalidatePath(detailHref(packageId));
  redirect(`${detailHref(packageId)}?saved=1`);
}

/**
 * "Satıştan kaldır" / "Satışa aç" on the package's own screen: the same PATCH
 * and the same permission (SHOWCASE_PACKAGES_WRITE) as the edit form, carrying
 * `isActive` alone. Nothing sold is touched either way — a package taken off
 * sale only stops new purchases; every run already bought keeps its own copy.
 */
export async function updateShowcasePackageStatusAction(formData: FormData) {
  const packageId = readString(formData, 'packageId');
  const isActive = readString(formData, 'isActive') === 'true';
  // Both directions are asked in a dialog; the proof is the one for the
  // direction asked for.
  if (!(await hasConfirmationProof(formData, isActive ? 'showcase-package.activate' : 'showcase-package.deactivate'))) {
    redirect(failureHref(packageId, CONFIRMATION_REQUIRED));
  }

  try {
    await apiFetch(`/admin/showcase/packages/${packageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(failureHref(packageId, errorCode(error)));
  }

  revalidatePath('/showcase/packages');
  revalidatePath(detailHref(packageId));
  redirect(`${detailHref(packageId)}?${isActive ? 'activated' : 'deactivated'}=1`);
}

/** The refusal code a submission without its confirmation proof comes back with. */
const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

/**
 * The proofs an edit needs, from the stored package. One that cannot be read
 * is treated as changing everything the save could: refused unless confirmed.
 */
async function requiredEditProofs(packageId: string, formData: FormData): Promise<ConfirmationProofKey[]> {
  const nextActive = formData.get('isActive') === 'on';
  const statusKey: ConfirmationProofKey = nextActive ? 'showcase-package.activate' : 'showcase-package.deactivate';
  let stored: ShowcasePackage;
  try {
    stored = await apiFetch<ShowcasePackage>(`/admin/showcase/packages/${encodeURIComponent(packageId)}`);
  } catch (error) {
    rethrowNextControlFlow(error);
    return ['showcase-package.update-commercial', statusKey];
  }
  const keys: ConfirmationProofKey[] = [];
  if (showcasePackageTermsChanges(stored, readShowcaseTerms(formData, stored.currency)).length > 0) {
    keys.push('showcase-package.update-commercial');
  }
  if (nextActive !== stored.isActive) keys.push(statusKey);
  return keys;
}

/** The `?paket=` value that opens the new-package window. */
const NEW_PACKAGE_KEY = 'yeni';

function detailHref(packageId: string): string {
  return `/showcase/packages/${encodeURIComponent(packageId)}`;
}

/**
 * A refusal goes back to the form it came from, with the reason beside it: the
 * new-package window on the list (`?paket=yeni`), or the package's own screen
 * (ADMIN-DESIGN-001 Faz 3F.1).
 */
function failureHref(packageKey: string, code: string): string {
  if (!packageKey || packageKey === NEW_PACKAGE_KEY) {
    return `/showcase/packages?${new URLSearchParams({ paket: NEW_PACKAGE_KEY, error: code }).toString()}`;
  }
  return `${detailHref(packageKey)}?${new URLSearchParams({ error: code }).toString()}`;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readOptional(formData: FormData, key: string): string | null {
  const value = readString(formData, key);
  return value.length > 0 ? value : null;
}

function readInt(formData: FormData, key: string): number {
  return Number.parseInt(readString(formData, key), 10);
}

function readOptionalInt(formData: FormData, key: string): number | null {
  const raw = readString(formData, key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { code?: unknown };
      if (typeof parsed.code === 'string') {
        return parsed.code;
      }
    } catch {
      // Not JSON, or JSON with no code.
    }
  }

  return 'SHOWCASE_PACKAGE_SAVE_FAILED';
}
