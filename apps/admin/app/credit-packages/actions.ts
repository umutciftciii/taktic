'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, OfferCreditPackage, parseDecimalToMinor } from '../../lib/api';

const ALLOWED_CURRENCIES = ['TRY', 'USD', 'EUR'] as const;
type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

// `priceAmount` is the minor-unit integer the API expects (kuruş for TRY,
// cents for USD/EUR). `priceInput` keeps the user's original decimal entry so
// validation errors can re-hydrate the form without losing keystrokes.
type PackageDraft = {
  name: string;
  slug: string;
  creditAmount: number;
  priceAmount: number;
  priceInput: string;
  currency: AllowedCurrency;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

export async function createCreditPackageAction(formData: FormData) {
  const draft = readDraft(formData);

  const validationError = validateDraft(draft);
  if (validationError) {
    redirect(buildNewUrl(draft, validationError));
  }

  let created: OfferCreditPackage | null = null;
  let errorMessage: string | null = null;

  try {
    created = await apiFetch<OfferCreditPackage>('/credit-packages', {
      method: 'POST',
      body: JSON.stringify(payloadFromDraft(draft)),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage || !created) {
    redirect(buildNewUrl(draft, errorMessage ?? 'Paket oluşturulamadı.'));
  }

  revalidatePath('/credit-packages');
  redirect(`/credit-packages/${created!.id}?ok=created`);
}

export async function updateCreditPackageAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const draft = readDraft(formData);

  const validationError = validateDraft(draft);
  if (validationError) {
    redirect(`/credit-packages/${id}?error=${encodeURIComponent(validationError)}`);
  }

  let errorMessage: string | null = null;
  try {
    await apiFetch<OfferCreditPackage>(`/credit-packages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payloadFromDraft(draft)),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  if (errorMessage) {
    redirect(`/credit-packages/${id}?error=${encodeURIComponent(errorMessage)}`);
  }

  revalidatePath('/credit-packages');
  revalidatePath(`/credit-packages/${id}`);
  redirect(`/credit-packages/${id}?ok=saved`);
}

export async function updateCreditPackageStatusAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const isActive = readFormString(formData, 'isActive') === 'true';
  const redirectTo = readFormString(formData, 'redirectTo') || '/credit-packages';

  let errorMessage: string | null = null;
  try {
    await apiFetch<OfferCreditPackage>(`/credit-packages/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  revalidatePath('/credit-packages');
  revalidatePath(`/credit-packages/${id}`);

  redirect(appendQuery(redirectTo, errorMessage ? { error: errorMessage } : { ok: isActive ? 'activated' : 'deactivated' }));
}

export async function moveCreditPackageAction(formData: FormData) {
  const id = readFormString(formData, 'id');
  const direction = readFormString(formData, 'direction') === 'up' ? 'up' : 'down';

  let errorMessage: string | null = null;
  let partialFailure = false;

  try {
    const packages = await apiFetch<OfferCreditPackage[]>('/credit-packages?includeInactive=true');
    const sorted = [...packages].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, 'tr-TR') ||
        a.id.localeCompare(b.id),
    );

    const index = sorted.findIndex((p) => p.id === id);
    if (index < 0) {
      errorMessage = 'Paket bulunamadı.';
    } else {
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex >= 0 && swapIndex < sorted.length) {
        const current = sorted[index]!;
        const neighbor = sorted[swapIndex]!;

        if (current.sortOrder === neighbor.sortOrder) {
          const nextOrder =
            direction === 'up' ? Math.max(0, neighbor.sortOrder - 1) : neighbor.sortOrder + 1;
          await apiFetch(`/credit-packages/${current.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sortOrder: nextOrder }),
          });
        } else {
          await apiFetch(`/credit-packages/${current.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sortOrder: neighbor.sortOrder }),
          });
          try {
            await apiFetch(`/credit-packages/${neighbor.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ sortOrder: current.sortOrder }),
            });
          } catch (innerError) {
            if (isRedirectError(innerError)) throw innerError;
            partialFailure = true;
            errorMessage = `Sıra takasının ikinci adımı başarısız oldu: ${extractApiMessage(innerError)}`;
          }
        }
      }
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    errorMessage = extractApiMessage(error);
  }

  revalidatePath('/credit-packages');

  if (errorMessage) {
    const qs = new URLSearchParams({ error: errorMessage });
    if (partialFailure) qs.set('partial', '1');
    redirect(`/credit-packages?${qs.toString()}`);
  }
}

function readDraft(formData: FormData): PackageDraft {
  const priceInput = readFormString(formData, 'priceAmount').trim();
  // parseDecimalToMinor returns null for invalid/empty input; downstream
  // validation surfaces a user-friendly error message in that case.
  const priceAmountMinor = parseDecimalToMinor(priceInput) ?? 0;

  return {
    name: readFormString(formData, 'name').trim(),
    slug: readFormString(formData, 'slug').trim(),
    creditAmount: readFormNumber(formData, 'creditAmount'),
    priceAmount: priceAmountMinor,
    priceInput,
    currency: normalizeCurrency(readFormString(formData, 'currency')),
    description: readOptionalFormString(formData, 'description'),
    sortOrder: readFormNumber(formData, 'sortOrder'),
    isActive: readFormString(formData, 'isActive') === 'true',
  };
}

function payloadFromDraft(draft: PackageDraft) {
  return {
    name: draft.name,
    slug: draft.slug,
    creditAmount: draft.creditAmount,
    priceAmount: draft.priceAmount,
    currency: draft.currency,
    description: draft.description,
    sortOrder: draft.sortOrder,
    isActive: draft.isActive,
  };
}

function validateDraft(draft: PackageDraft): string | null {
  if (!draft.name) return 'Paket adı zorunludur.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) {
    return 'Slug yalnızca küçük harf, rakam ve tire (-) içerebilir.';
  }
  if (!Number.isInteger(draft.creditAmount) || draft.creditAmount < 1) {
    return 'Kredi tutarı en az 1 olmalıdır.';
  }
  // priceAmount is stored in minor units; 100 = 1,00 in the selected currency.
  // Empty / non-numeric inputs are normalised to 0 in readDraft, which falls
  // into the same branch as values < 1,00.
  if (!Number.isInteger(draft.priceAmount) || draft.priceAmount < 100) {
    return 'Fiyat en az 1,00 olmalıdır. Ondalıklı tutar girebilirsiniz (örn. 149,90).';
  }
  if (!ALLOWED_CURRENCIES.includes(draft.currency)) {
    return 'Geçersiz para birimi.';
  }
  if (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0) {
    return 'Sıralama 0 veya pozitif tam sayı olmalıdır.';
  }
  return null;
}

function buildNewUrl(draft: PackageDraft, errorMessage: string) {
  const params = new URLSearchParams();
  params.set('error', errorMessage);
  if (draft.name) params.set('name', draft.name);
  if (draft.slug) params.set('slug', draft.slug);
  params.set('creditAmount', String(draft.creditAmount || ''));
  // Preserve the original decimal entry verbatim so the user does not lose
  // their input after a validation error (e.g. "149,90" stays as typed).
  params.set('priceAmount', draft.priceInput);
  params.set('currency', draft.currency);
  if (draft.description) params.set('description', draft.description);
  params.set('sortOrder', String(draft.sortOrder || 0));
  params.set('isActive', String(draft.isActive));
  return `/credit-packages/new?${params.toString()}`;
}

function appendQuery(url: string, params: Record<string, string>) {
  const [path, existing] = url.split('?');
  const search = new URLSearchParams(existing ?? '');
  for (const [key, value] of Object.entries(params)) {
    search.set(key, value);
  }
  return `${path}?${search.toString()}`;
}

function normalizeCurrency(value: string): AllowedCurrency {
  const upper = value.trim().toUpperCase();
  return (ALLOWED_CURRENCIES as readonly string[]).includes(upper)
    ? (upper as AllowedCurrency)
    : 'TRY';
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
