'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../lib/api';

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
  try {
    await apiFetch('/admin/showcase/packages', {
      method: 'POST',
      body: JSON.stringify({
        name: readString(formData, 'name'),
        slug: readString(formData, 'slug'),
        priceAmount: readInt(formData, 'priceAmount'),
        durationDays: readInt(formData, 'durationDays'),
        activationWindowDays: readInt(formData, 'activationWindowDays'),
        allowedCardKind: readOptional(formData, 'allowedCardKind'),
        maxAreas: readOptionalInt(formData, 'maxAreas'),
        description: readOptional(formData, 'description'),
        sortOrder: readOptionalInt(formData, 'sortOrder') ?? 0,
      }),
    });
  } catch (error) {
    redirect(`/showcase/packages?error=${errorCode(error)}`);
  }

  revalidatePath('/showcase/packages');
  redirect('/showcase/packages?created=1');
}

export async function updateShowcasePackageAction(formData: FormData) {
  const packageId = readString(formData, 'packageId');

  try {
    await apiFetch(`/admin/showcase/packages/${packageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: readString(formData, 'name'),
        priceAmount: readInt(formData, 'priceAmount'),
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
    redirect(`/showcase/packages?error=${errorCode(error)}`);
  }

  revalidatePath('/showcase/packages');
  redirect('/showcase/packages?saved=1');
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
        return encodeURIComponent(parsed.code);
      }
    } catch {
      // Not JSON, or JSON with no code.
    }
  }

  return 'SHOWCASE_PACKAGE_SAVE_FAILED';
}
