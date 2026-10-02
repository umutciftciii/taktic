'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../../lib/api';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';
import { isPlacementCancelNoteValid, isPlacementSuspendNoteValid } from './placement-cancel';
import { hasConfirmationProof } from '../../../lib/confirmation-proof-server';

/**
 * The three things an operator may do to a paid run.
 *
 * There is no fourth, and the absences are the design:
 *
 * - **no create** — a run is born from a settled payment. A "grant a placement"
 *   action would be free advertising with nobody's payment behind it, and it
 *   would make `ShowcasePlacement.purchaseId` a lie.
 * - **no extend** — time is sold, not given. The only thing that moves the end
 *   date forward is a clock-stopping suspension being lifted, and even then an
 *   operator does not type the date: `resume()` computes it.
 * - **no delete** — the run is the record of what a business paid for.
 * - **no refund** — cancelling flags the purchase for a person. Money is moved
 *   by people, through the same manual path a chargeback takes.
 */

export async function suspendShowcasePlacementAction(formData: FormData) {
  const placementId = readString(formData, 'placementId');
  const target = `/showcase/placements/${placementId}`;
  // Required, as the API requires it (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket
  // B): the provider is not mailed, so the note is the record of why. Refused
  // here before any request, with the API's own code.
  const note = readString(formData, 'note');
  if (!isPlacementSuspendNoteValid(note)) {
    redirect(`${target}?error=SHOWCASE_PLACEMENT_SUSPEND_NOTE_REQUIRED`);
  }
  // Confirmed in a dialog; without its proof nothing is taken off the air.
  if (!(await hasConfirmationProof(formData, 'showcase.placement-suspend'))) {
    redirect(`${target}?error=CONFIRMATION_REQUIRED`);
  }

  try {
    await apiFetch(`/admin/showcase/placements/${placementId}/suspend`, {
      method: 'POST',
      // No `reason`. An operator's hold is ADMIN_ACTION by definition, and a
      // reason the form could choose could name one that does not stop the
      // clock — an operator quietly billing a provider for days the platform
      // took away.
      body: JSON.stringify({ note }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  revalidatePath('/showcase/placements');
  redirect(`${target}?suspended=1`);
}

export async function resumeShowcasePlacementAction(formData: FormData) {
  const placementId = readString(formData, 'placementId');
  const target = `/showcase/placements/${placementId}`;

  try {
    await apiFetch(`/admin/showcase/placements/${placementId}/resume`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  revalidatePath('/showcase/placements');
  redirect(`${target}?resumed=1`);
}

export async function cancelShowcasePlacementAction(formData: FormData) {
  const placementId = readString(formData, 'placementId');
  const target = `/showcase/placements/${placementId}`;
  // Required, as the API requires it (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  // Refused here before any request, with the API's own code, so a form that
  // skipped the browser's check gets the same message the API would give.
  const note = readString(formData, 'note');
  if (!isPlacementCancelNoteValid(note)) {
    redirect(`${target}?error=SHOWCASE_PLACEMENT_CANCEL_NOTE_REQUIRED`);
  }
  // Confirmed in a dialog; without its proof nothing is cancelled.
  if (!(await hasConfirmationProof(formData, 'showcase.placement-cancel'))) {
    redirect(`${target}?error=CONFIRMATION_REQUIRED`);
  }

  try {
    await apiFetch(`/admin/showcase/placements/${placementId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(`${target}?error=${errorCode(error)}`);
  }

  revalidatePath(target);
  revalidatePath('/showcase/placements');
  redirect(`${target}?cancelled=1`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
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

  return 'SHOWCASE_PLACEMENT_ACTION_FAILED';
}
