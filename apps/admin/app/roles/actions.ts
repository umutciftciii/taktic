'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '../../lib/api';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../lib/confirmation-proof-keys';
import type { ConfirmationProofKey } from '../../lib/confirmation-proof-keys';

/**
 * Creating, editing and handing out roles.
 *
 * Every one of these is a root capability: the API refuses anyone but a
 * SUPER_ADMIN, because a role that could edit roles could give itself anything
 * (RG-7 §12.1). Nothing here checks that — the server does — and these actions
 * only carry the operator's intent and the API's answer back to the screen.
 */

export async function createAdminRoleAction(formData: FormData) {
  const key = readString(formData, 'key').trim();
  const name = readString(formData, 'name').trim();
  const description = readString(formData, 'description').trim();
  const permissions = formData.getAll('permissions').map(String).filter(Boolean);

  if (key.length < 2 || name.length < 2) {
    redirect('/roles?error=' + encodeURIComponent('Rol anahtarı ve adı zorunludur.'));
  }

  let created: { id: string } | null = null;
  let errorMessage: string | null = null;
  try {
    created = await apiFetch<{ id: string }>('/admin/roles', {
      method: 'POST',
      body: JSON.stringify({ key, name, description: description || null, permissions }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage || !created) {
    redirect('/roles?error=' + encodeURIComponent(errorMessage ?? 'Rol oluşturulamadı.'));
  }

  revalidatePath('/roles');
  redirect(`/roles/${created.id}?ok=created`);
}

export async function updateAdminRoleAction(formData: FormData) {
  const id = readString(formData, 'roleId');
  const name = readString(formData, 'name').trim();
  const description = readString(formData, 'description').trim();

  let errorMessage: string | null = null;
  try {
    await apiFetch(`/admin/roles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description: description || null }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  finish(`/roles/${id}`, errorMessage, 'updated');
}

/**
 * Deactivating a role takes its permissions from everyone holding it, at once
 * and without touching a single assignment row — the session's permission read
 * filters on `role.isActive` — and reactivating gives them all back the same
 * way. Both directions are confirmed in a dialog, and the dialog's single-use
 * proof is checked here before anything is sent
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001). It replaced the hydrated
 * `confirm=on` field, a fixed value any hand-built request could carry.
 */
export async function setAdminRoleActiveAction(formData: FormData) {
  const id = readString(formData, 'roleId');
  const isActive = readString(formData, 'isActive') === 'true';

  await refuseWithoutProof(formData, 'role.status', `/roles/${id}`);

  let errorMessage: string | null = null;
  try {
    await apiFetch(`/admin/roles/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  finish(`/roles/${id}`, errorMessage, isActive ? 'activated' : 'deactivated');
}

export async function replaceAdminRolePermissionsAction(formData: FormData) {
  const id = readString(formData, 'roleId');
  const permissions = formData.getAll('permissions').map(String).filter(Boolean);

  await refuseWithoutProof(formData, 'role.permissions', `/roles/${id}`);

  let errorMessage: string | null = null;
  try {
    await apiFetch(`/admin/roles/${id}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  finish(`/roles/${id}`, errorMessage, 'permissions');
}

export async function assignAdminRoleAction(formData: FormData) {
  const userId = readString(formData, 'userId');
  const roleId = readString(formData, 'roleId');

  await refuseWithoutProof(formData, 'role.assign', `/users/${userId}`);

  let errorMessage: string | null = null;
  try {
    await apiFetch(`/admin/users/${userId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ roleId }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  finish(`/users/${userId}`, errorMessage, 'role-assigned');
}

export async function revokeAdminRoleAction(formData: FormData) {
  const userId = readString(formData, 'userId');
  const roleId = readString(formData, 'roleId');

  await refuseWithoutProof(formData, 'role.revoke', `/users/${userId}`);

  let errorMessage: string | null = null;
  try {
    await apiFetch(`/admin/users/${userId}/roles/${roleId}`, { method: 'DELETE' });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  finish(`/users/${userId}`, errorMessage, 'role-revoked');
}

/**
 * Every write here is confirmed in a dialog; a submission without the
 * dialog's proof goes back with the reason and sends nothing.
 */
async function refuseWithoutProof(formData: FormData, key: ConfirmationProofKey, path: string) {
  if (!(await hasConfirmationProof(formData, key))) {
    redirect(`${path}?error=${encodeURIComponent(CONFIRMATION_PROOF_REFUSAL_MESSAGE)}`);
  }
}

function finish(path: string, errorMessage: string | null, ok: string): never {
  if (errorMessage) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage)}`);
  }
  revalidatePath(path);
  redirect(`${path}?ok=${ok}`);
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function extractApiMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Beklenmeyen hata.';
  const raw = error.message;
  try {
    const parsed = JSON.parse(raw) as { message?: string | string[]; error?: string };
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    /* fall through */
  }
  return raw || 'Beklenmeyen hata.';
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
