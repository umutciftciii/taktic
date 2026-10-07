'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';
import { CONFIRMATION_PROOF_REFUSAL_MESSAGE } from '../../lib/confirmation-proof-keys';
import { hasConfirmationProof } from '../../lib/confirmation-proof-server';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import { readSeoRefusal, seoRefusalMessage, type SeoSlugPreview } from '../../lib/seo';
import type { SeoFormState } from './seo-form-state';

/**
 * The SEO screens' writes (SEO-004 PR B). Each one is the API route PR A
 * built, called once; nothing here decides what the API decides.
 *
 * - A slug change asks first (`seo.slug-change`): it moves a public address and,
 *   for a public category, writes a mandatory 301 in the same transaction.
 * - Removing a redirect (a soft deactivate), approving a 404 suggestion (it
 *   writes a live redirect) and rejecting one ask first as well.
 * - Creating and editing a redirect are the window's own explicit submit.
 *
 * A refusal comes back as form state — the sentence for its code, the field it
 * names — with everything typed kept. A 401/403 is `apiFetch`'s, as on every
 * screen: the sign-in form or /yetkisiz, never a message quoting the refusal.
 */

const SLUGS_PATH = '/seo/slugs';
const REDIRECTS_PATH = '/seo/redirects';

function refusal(error: unknown): SeoFormState {
  if (error instanceof ApiError) {
    const body = readSeoRefusal(error.body);
    return {
      kind: 'error',
      message: seoRefusalMessage(body, error.status),
      field: typeof body?.field === 'string' ? body.field : null,
      code: typeof body?.code === 'string' ? body.code : null,
      at: Date.now(),
    };
  }
  return { kind: 'error', message: seoRefusalMessage(null), field: null, code: null, at: Date.now() };
}

function proofRefused(): SeoFormState {
  return { kind: 'error', message: CONFIRMATION_PROOF_REFUSAL_MESSAGE, field: null, code: null, at: Date.now() };
}

function readString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** A redirect type from the form, or null for anything that is not one. */
function readType(formData: FormData): 'PERMANENT' | 'TEMPORARY' | null {
  const value = readString(formData, 'type');
  return value === 'PERMANENT' || value === 'TEMPORARY' ? value : null;
}

/** A path the operator typed, with the leading "/" the field's prefix shows. */
function readPath(formData: FormData, name: string): string {
  const value = readString(formData, name).trim();
  if (value === '' || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `/${value}`;
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * What saving a slug would do, read while the operator types. Advisory only —
 * the write decides again under the graph lock — and silent on failure: the
 * window then shows the local preview and lets the save answer.
 */
export async function previewSlugChangeAction(categoryId: string, slug: string): Promise<SeoSlugPreview | null> {
  if (!categoryId || !slug.trim() || slug.length > 200) return null;
  try {
    return await apiFetch<SeoSlugPreview>(
      `/admin/seo/categories/${encodeURIComponent(categoryId)}/slug-preview?${new URLSearchParams({ slug }).toString()}`,
    );
  } catch (error) {
    rethrowNextControlFlow(error);
    return null;
  }
}

export async function changeCategorySlugAction(_previous: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const categoryId = readString(formData, 'categoryId');
  const slug = readString(formData, 'slug');
  const returnTo = readString(formData, 'returnTo');
  if (!categoryId) return refusal(null);
  if (!(await hasConfirmationProof(formData, 'seo.slug-change'))) return proofRefused();

  let result: { category: { slug: string; path: string }; redirect: { sourcePath: string } | null };
  try {
    result = await apiFetch(`/admin/seo/categories/${encodeURIComponent(categoryId)}/slug`, {
      method: 'POST',
      body: JSON.stringify({ slug }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    return refusal(error);
  }

  revalidatePath(SLUGS_PATH);
  revalidatePath(REDIRECTS_PATH);
  revalidatePath('/categories');
  const done = new URLSearchParams({ adres: result.category.path, yonlendirme: result.redirect ? '1' : '0' });
  // From the category's own screen, back to it — under its new address.
  if (returnTo === 'category') {
    redirect(`/categories/${encodeURIComponent(result.category.slug)}?${done.toString()}`);
  }
  redirect(`${SLUGS_PATH}?${done.toString()}`);
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

export async function createRedirectAction(_previous: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const type = readType(formData);
  if (!type) {
    return { kind: 'error', message: 'Yönlendirme türü seçilmeli.', field: 'type', code: null, at: Date.now() };
  }
  try {
    await apiFetch('/admin/seo/redirects', {
      method: 'POST',
      body: JSON.stringify({
        sourcePath: readPath(formData, 'sourcePath'),
        targetPath: readPath(formData, 'targetPath'),
        type,
        reason: readString(formData, 'reason'),
      }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    return refusal(error);
  }
  revalidatePath(REDIRECTS_PATH);
  revalidatePath('/seo');
  redirect(`${REDIRECTS_PATH}?ok=eklendi`);
}

/**
 * Target, type and reason; the source never changes (the API has no field for
 * it). A slug-change redirect stays 301: its form sends no type at all.
 */
export async function updateRedirectAction(_previous: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const redirectId = readString(formData, 'redirectId');
  if (!redirectId) return refusal(null);
  const type = readType(formData);
  const body: Record<string, string> = {
    targetPath: readPath(formData, 'targetPath'),
    reason: readString(formData, 'reason'),
  };
  if (type) body.type = type;
  try {
    await apiFetch(`/admin/seo/redirects/${encodeURIComponent(redirectId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    return refusal(error);
  }
  revalidatePath(REDIRECTS_PATH);
  redirect(`${REDIRECTS_PATH}?ok=guncellendi`);
}

/** "Kaldır": a soft deactivate — the row stays, inactive, with who and when. */
export async function deactivateRedirectAction(formData: FormData) {
  const redirectId = readString(formData, 'redirectId');
  const back = readString(formData, 'back') || REDIRECTS_PATH;
  const safeBack = back.startsWith(`${REDIRECTS_PATH}`) ? back : REDIRECTS_PATH;
  if (!(await hasConfirmationProof(formData, 'seo.redirect-deactivate'))) {
    redirect(withParam(safeBack, 'hata', 'CONFIRMATION_REQUIRED'));
  }
  try {
    await apiFetch(`/admin/seo/redirects/${encodeURIComponent(redirectId)}/deactivate`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(withParam(safeBack, 'hata', errorCode(error)));
  }
  revalidatePath(REDIRECTS_PATH);
  revalidatePath('/seo');
  revalidatePath(SLUGS_PATH);
  redirect(withParam(safeBack, 'ok', 'kaldirildi'));
}

// ---------------------------------------------------------------------------
// 404 suggestions
// ---------------------------------------------------------------------------

/** Turns one open suggestion into a redirect — never without this press. */
export async function approveSuggestionAction(_previous: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const suggestionId = readString(formData, 'suggestionId');
  if (!suggestionId) return refusal(null);
  if (!(await hasConfirmationProof(formData, 'seo.suggestion-approve'))) return proofRefused();
  const type = readType(formData);
  const target = readPath(formData, 'targetPath');
  const reason = readString(formData, 'reason').trim();
  try {
    await apiFetch(`/admin/seo/not-found/${encodeURIComponent(suggestionId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        ...(target ? { targetPath: target } : {}),
        ...(type ? { type } : {}),
        ...(reason ? { reason } : {}),
      }),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    return refusal(error);
  }
  revalidatePath(REDIRECTS_PATH);
  revalidatePath('/seo');
  redirect(`${REDIRECTS_PATH}?sekme=oneriler&ok=onaylandi`);
}

export async function rejectSuggestionAction(formData: FormData) {
  const suggestionId = readString(formData, 'suggestionId');
  const back = `${REDIRECTS_PATH}?sekme=oneriler`;
  if (!(await hasConfirmationProof(formData, 'seo.suggestion-reject'))) {
    redirect(withParam(back, 'hata', 'CONFIRMATION_REQUIRED'));
  }
  const reason = readString(formData, 'reason').trim();
  try {
    await apiFetch(`/admin/seo/not-found/${encodeURIComponent(suggestionId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  } catch (error) {
    rethrowNextControlFlow(error);
    redirect(withParam(back, 'hata', errorCode(error)));
  }
  revalidatePath(REDIRECTS_PATH);
  revalidatePath('/seo');
  redirect(withParam(back, 'ok', 'reddedildi'));
}

function withParam(href: string, name: string, value: string): string {
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.delete('ok');
  params.delete('hata');
  params.set(name, value);
  return `${path}?${params.toString()}`;
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    const code = readSeoRefusal(error.body)?.code;
    if (typeof code === 'string' && /^[A-Z_]{3,64}$/.test(code)) return code;
    if (error.status === 409) return 'CONFLICT';
  }
  return 'FAILED';
}
