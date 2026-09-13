'use server';

import { cookies } from 'next/headers';
import { apiUrl } from '../app/api-base';
import { appCookieOptions } from '../app/session-cookie';
import { clientForwardingHeaders } from './forwarded-for';
import { decodeRouterSelections } from './request-flow';
import { readFormString, readOptionalFormString } from './service-request-payload';
import { parseLiraToMinor } from './lira-input';

const COOKIE_NAME = 'taktic_request_draft';
const TTL_SECONDS = 24 * 60 * 60;

export type DraftFormType = 'MARKETPLACE' | 'SHOWCASE_LEAD';
export type RequestDraftPayload = {
  city?: string;
  district?: string;
  neighborhood?: string;
  addressNote?: string;
  urgency?: string;
  urgencyBucket?: string;
  preferredDate?: string;
  budgetMin?: number;
  budgetMax?: number;
  description?: string;
  answers?: { questionKey: string; value: unknown }[];
  routerSelections?: { questionKey: string; optionKey: string }[];
};
export type SaveDraftResult =
  | { ok: true }
  | { ok: false; code: 'DRAFT_EXISTS' | 'DRAFT_NOT_CONTINUABLE' | 'DRAFT_BUSY' | 'DRAFT_FAILED' };

/**
 * Parks the form on the server and hands the browser the opaque token as an
 * HttpOnly cookie on the web origin. The token is read from the API's JSON
 * reply here, server to server, and never reaches the page.
 */
export async function saveRequestDraftAction(input: {
  formType: DraftFormType;
  categorySlug: string;
  cardId?: string | null;
  payload: RequestDraftPayload;
  identity: { phone: string; email: string };
  replace?: boolean;
}): Promise<SaveDraftResult> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  const response = await fetch(`${apiUrl}/request-drafts`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(existing ? { cookie: `${COOKIE_NAME}=${existing}` } : {}),
      ...(await clientForwardingHeaders()),
    },
    body: JSON.stringify({
      formType: input.formType,
      categorySlug: input.categorySlug,
      ...(input.cardId ? { cardId: input.cardId } : {}),
      payload: input.payload,
      identity: input.identity,
      ...(input.replace ? { replace: true } : {}),
    }),
  });

  if (!response.ok) {
    let code: string | null = null;
    try {
      code = (JSON.parse(await response.text()) as { code?: string }).code ?? null;
    } catch {
      /* not JSON */
    }
    console.error(`[request draft] save refused with ${response.status} code=${code ?? '-'}`);
    if (code === 'DRAFT_EXISTS' || code === 'DRAFT_NOT_CONTINUABLE') return { ok: false, code };
    if (response.status === 429 || response.status === 503) return { ok: false, code: 'DRAFT_BUSY' };
    return { ok: false, code: 'DRAFT_FAILED' };
  }

  const { token } = (await response.json()) as { token: string };
  // `appCookieOptions` already reads whether this request arrived over TLS at
  // runtime — see session-cookie.ts for why that, and not a build-time
  // NODE_ENV check, is the only thing allowed to decide `secure` here.
  cookieStore.set(COOKIE_NAME, token, await appCookieOptions({ maxAge: TTL_SECONDS }));
  return { ok: true };
}

/**
 * "Vazgeç" on a form that opened a draft. The API deletes the row only when
 * it is the one this form showed — same key, and anonymous or the session's
 * own (see `RequestDraftsService.discard`) — and answers `{ deleted }`. The
 * cookie goes only on `deleted: true`: a cookie that still names a live row
 * (somebody else's protected draft, another form's) is that row's only way
 * back and is kept. A plain `fetch`, not `apiFetch`: the reply is read here
 * and a transport failure is a `false`, never an error page.
 */
export async function discardRequestDraftAction(key: {
  formType: DraftFormType;
  categorySlug: string;
  cardId?: string | null;
}): Promise<{ deleted: boolean }> {
  const cookieStore = await cookies();
  if (!cookieStore.get(COOKIE_NAME)) return { deleted: false };
  const query = new URLSearchParams({
    formType: key.formType,
    categorySlug: key.categorySlug,
    ...(key.cardId ? { cardId: key.cardId } : {}),
  });
  let deleted = false;
  try {
    const response = await fetch(`${apiUrl}/request-drafts/current?${query}`, {
      method: 'DELETE',
      cache: 'no-store',
      headers: { cookie: cookieStore.toString() },
    });
    if (response.ok) {
      deleted = ((await response.json()) as { deleted?: boolean }).deleted === true;
    } else {
      console.error(`[request draft] discard refused with ${response.status}`);
    }
  } catch (error) {
    console.error('[request draft] discard failed', error);
  }
  if (deleted) await clearRequestDraftCookie();
  return { deleted };
}

export async function clearRequestDraftCookie(): Promise<void> {
  (await cookies()).set(COOKIE_NAME, '', { ...(await appCookieOptions({ maxAge: 0 })), maxAge: 0 });
}

export async function readCurrentDraft(key: {
  formType: DraftFormType;
  categorySlug: string;
  cardId?: string | null;
}): Promise<{ kind: 'none' } | { kind: 'payload'; payload: RequestDraftPayload } | { kind: 'wrong-account' }> {
  if (!(await cookies()).get(COOKIE_NAME)) return { kind: 'none' as const };
  const query = new URLSearchParams({
    formType: key.formType,
    categorySlug: key.categorySlug,
    ...(key.cardId ? { cardId: key.cardId } : {}),
  });
  try {
    const response = await fetch(`${apiUrl}/request-drafts/current?${query}`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (response.status === 204) return { kind: 'none' as const };
    if (!response.ok) return { kind: 'none' as const };
    const body = (await response.json()) as { payload?: RequestDraftPayload; status?: string };
    if (body.status === 'wrong-account') return { kind: 'wrong-account' as const };
    return body.payload ? { kind: 'payload' as const, payload: body.payload } : { kind: 'none' as const };
  } catch {
    return { kind: 'none' as const };
  }
}

/** The draft payload from a posted form: the request body minus every contact field. */
export async function draftPayloadFromForm(formData: FormData): Promise<RequestDraftPayload> {
  const questionMeta = readFormString(formData, 'questionMeta');
  let meta: { key: string; type: string }[] = [];
  try {
    meta = JSON.parse(questionMeta || '[]');
  } catch {
    meta = [];
  }
  const answers = meta.map((q) => ({
    questionKey: q.key,
    value:
      q.type === 'MULTI_SELECT'
        ? formData.getAll(`answer_${q.key}`).filter((v): v is string => typeof v === 'string' && v !== '')
        : q.type === 'BOOLEAN'
          ? formData.get(`answer_${q.key}`) === 'true'
          : readFormString(formData, `answer_${q.key}`),
  }));
  const opt = (k: string) => readOptionalFormString(formData, k) ?? undefined;
  const budgetMin = parseLiraToMinor(readFormString(formData, 'budgetMin'));
  const budgetMax = parseLiraToMinor(readFormString(formData, 'budgetMax'));
  return {
    city: opt('city'),
    district: opt('district'),
    neighborhood: opt('neighborhood'),
    addressNote: opt('addressNote'),
    urgency: opt('urgency'),
    urgencyBucket: opt('urgencyBucket'),
    preferredDate: opt('preferredDate'),
    ...(budgetMin !== null ? { budgetMin } : {}),
    ...(budgetMax !== null ? { budgetMax } : {}),
    description: opt('description'),
    answers,
    routerSelections: decodeRouterSelections(readOptionalFormString(formData, 'routerSelections')),
  };
}
