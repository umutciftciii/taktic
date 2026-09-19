'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  apiFetch,
  type CampaignDetailResponse,
  type CampaignRuleError,
  type CampaignValidationResponse,
} from '../../lib/api';
import type { CampaignFormState } from './form-state';

/**
 * The builder's two verbs: check, and save.
 *
 * Both post the definition the form assembled (as one JSON field the operator
 * never sees or edits) and both hand it to the API, which is the only judge
 * of it. "Check" calls the validate-only route and writes nothing; "save"
 * creates the campaign or adds a version, and redirects to the detail on
 * success. On refusal the API's field-level errors come back as the action's
 * state, so the form can put each sentence beside the input it names.
 *
 * Nothing about who is doing this travels in the payload; the API takes the
 * operator from the session.
 */

type ParsedSubmission =
  | { ok: true; intent: 'validate' | 'save'; key: string; name: string; campaignId: string | null; definition: unknown }
  | { ok: false; message: string };

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function parseSubmission(formData: FormData): ParsedSubmission {
  const intent = readString(formData, 'intent');
  if (intent !== 'validate' && intent !== 'save') {
    return { ok: false, message: 'Bilinmeyen işlem.' };
  }
  const raw = readString(formData, 'definition');
  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'Form verisi okunamadı; sayfayı yenileyip tekrar deneyin.' };
  }
  const campaignId = readString(formData, 'campaignId').trim() || null;
  return {
    ok: true,
    intent,
    key: readString(formData, 'key').trim(),
    name: readString(formData, 'name').trim(),
    campaignId,
    definition,
  };
}

export async function campaignFormAction(
  _previous: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const parsed = parseSubmission(formData);
  if (!parsed.ok) {
    return { status: 'error', errors: [], summary: null, message: parsed.message };
  }

  if (parsed.intent === 'validate') {
    return validateOnly(parsed.definition);
  }

  // Client-side only the two identity fields, and only on creation: they are
  // not part of the rule language and the API refuses them separately.
  if (parsed.campaignId === null) {
    if (parsed.key === '') {
      return { status: 'error', errors: [], summary: null, message: 'Kampanya anahtarı zorunludur.' };
    }
    if (parsed.name === '') {
      return { status: 'error', errors: [], summary: null, message: 'Kampanya adı zorunludur.' };
    }
  }

  let target: string | null = null;
  let failure: CampaignFormState | null = null;
  try {
    if (parsed.campaignId === null) {
      const created = await apiFetch<CampaignDetailResponse>('/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ key: parsed.key, name: parsed.name, definition: parsed.definition }),
      });
      target = `/campaigns/${created.campaign.id}?ok=created`;
    } else {
      const revised = await apiFetch<CampaignDetailResponse>(
        `/admin/campaigns/${encodeURIComponent(parsed.campaignId)}/versions`,
        { method: 'POST', body: JSON.stringify({ definition: parsed.definition }) },
      );
      target = `/campaigns/${revised.campaign.id}?ok=revised&v=${revised.currentVersion?.versionNumber ?? ''}`;
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    failure = failureState(error);
  }

  if (failure) {
    return failure;
  }

  revalidatePath('/campaigns');
  if (parsed.campaignId) revalidatePath(`/campaigns/${parsed.campaignId}`);
  redirect(target!);
}

async function validateOnly(definition: unknown): Promise<CampaignFormState> {
  try {
    const result = await apiFetch<CampaignValidationResponse>('/admin/campaigns/validate', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    });
    return result.valid
      ? { status: 'valid', errors: [], summary: result.summary, message: null }
      : { status: 'invalid', errors: result.errors, summary: null, message: null };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return failureState(error);
  }
}

/** The API's structured refusal when it sent one; its sentence otherwise. */
function failureState(error: unknown): CampaignFormState {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body) as {
        code?: string;
        message?: string | string[];
        errors?: CampaignRuleError[];
      };
      if (body.code === 'CAMPAIGN_DEFINITION_INVALID' && Array.isArray(body.errors)) {
        return { status: 'invalid', errors: body.errors, summary: null, message: null };
      }
      const message = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
      return { status: 'error', errors: [], summary: null, message: message || 'İşlem başarısız.' };
    } catch {
      return { status: 'error', errors: [], summary: null, message: error.body || 'İşlem başarısız.' };
    }
  }
  return { status: 'error', errors: [], summary: null, message: 'Beklenmeyen hata.' };
}

function isRedirectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}
