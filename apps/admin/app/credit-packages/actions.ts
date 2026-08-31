'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AdminOfferPackage,
  OfferCreditPackage,
  OfferPackageType,
  apiFetch,
  parseDecimalToMinor,
} from '../../lib/api';

const ALLOWED_CURRENCIES = ['TRY', 'USD', 'EUR'] as const;
type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

// `priceAmount` is the minor-unit integer the API expects (kuruş for TRY,
// cents for USD/EUR). `priceInput` keeps the user's original decimal entry so
// validation errors can re-hydrate the form without losing keystrokes.
type PackageDraft = {
  name: string;
  slug: string;
  /**
   * What the package sells. Chosen once, at creation: the edit form does not
   * send it, and the API refuses it, because changing what a package sells
   * would make every period already bought against it describe a product that
   * no longer exists.
   */
  type: OfferPackageType;
  creditAmount: number;
  quotaCredits: number;
  /** 0 means "no daily cap", which the API reads as null. */
  dailyOfferLimit: number;
  scopeCategoryIds: string[];
  priceAmount: number;
  priceInput: string;
  currency: AllowedCurrency;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

const PACKAGE_TYPES: readonly OfferPackageType[] = [
  'ONE_TIME_CREDITS',
  'MONTHLY_QUOTA',
  'CATEGORY_UNLIMITED',
];

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
      body: JSON.stringify(createPayloadFromDraft(draft)),
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
      body: JSON.stringify(updatePayloadFromDraft(draft)),
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
    // The admin listing rather than the public one: `GET /credit-packages`
    // answers unauthenticated callers and therefore returns only the one-time
    // packages, which would make reordering silently skip every period package.
    const packages = await apiFetch<AdminOfferPackage[]>('/admin/offer-packages');
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
    type: normalizePackageType(readFormString(formData, 'type')),
    creditAmount: readFormNumber(formData, 'creditAmount'),
    quotaCredits: readFormNumber(formData, 'quotaCredits'),
    dailyOfferLimit: readFormNumber(formData, 'dailyOfferLimit'),
    scopeCategoryIds: formData
      .getAll('scopeCategoryIds')
      .filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
    priceAmount: priceAmountMinor,
    priceInput,
    currency: normalizeCurrency(readFormString(formData, 'currency')),
    description: readOptionalFormString(formData, 'description'),
    sortOrder: readFormNumber(formData, 'sortOrder'),
    isActive: readFormString(formData, 'isActive') === 'true',
  };
}

function normalizePackageType(value: string): OfferPackageType {
  return (PACKAGE_TYPES as readonly string[]).includes(value)
    ? (value as OfferPackageType)
    : 'ONE_TIME_CREDITS';
}

/**
 * The payload for a create.
 *
 * Per-type, so a monthly quota is never sent a credit amount and an unlimited
 * package is never sent a quota — the API refuses those combinations and the
 * database makes them unrepresentable, and sending them anyway would turn a
 * clear message into a validation error about a field the admin never filled.
 */
function createPayloadFromDraft(draft: PackageDraft) {
  const shared = {
    name: draft.name,
    slug: draft.slug,
    type: draft.type,
    priceAmount: draft.priceAmount,
    currency: draft.currency,
    description: draft.description,
    sortOrder: draft.sortOrder,
    isActive: draft.isActive,
  };

  if (draft.type === 'MONTHLY_QUOTA') {
    return { ...shared, quotaCredits: draft.quotaCredits };
  }

  if (draft.type === 'CATEGORY_UNLIMITED') {
    return {
      ...shared,
      scopeCategoryIds: draft.scopeCategoryIds,
      ...(draft.dailyOfferLimit > 0 ? { dailyOfferLimit: draft.dailyOfferLimit } : {}),
    };
  }

  return { ...shared, creditAmount: draft.creditAmount };
}

/** The same, minus `type`, which is not editable. */
function updatePayloadFromDraft(draft: PackageDraft) {
  const { type: _type, ...rest } = createPayloadFromDraft(draft);

  if (draft.type === 'CATEGORY_UNLIMITED') {
    return { ...rest, dailyOfferLimit: draft.dailyOfferLimit > 0 ? draft.dailyOfferLimit : null };
  }

  return rest;
}

function validateDraft(draft: PackageDraft): string | null {
  if (!draft.name) return 'Paket adı zorunludur.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) {
    return 'Slug yalnızca küçük harf, rakam ve tire (-) içerebilir.';
  }
  if (draft.type === 'ONE_TIME_CREDITS') {
    if (!Number.isInteger(draft.creditAmount) || draft.creditAmount < 1) {
      return 'Kredi tutarı en az 1 olmalıdır.';
    }
  }
  if (draft.type === 'MONTHLY_QUOTA') {
    if (!Number.isInteger(draft.quotaCredits) || draft.quotaCredits < 1) {
      return 'Aylık kota en az 1 kredi olmalıdır.';
    }
  }
  if (draft.type === 'CATEGORY_UNLIMITED') {
    if (draft.scopeCategoryIds.length === 0) {
      return 'Limitsiz paket için en az bir kategori veya kategori grubu seçmelisiniz.';
    }
    if (!Number.isInteger(draft.dailyOfferLimit) || draft.dailyOfferLimit < 0) {
      return 'Günlük teklif limiti 0 (sınırsız) veya pozitif tam sayı olmalıdır.';
    }
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
  params.set('type', draft.type);
  params.set('creditAmount', String(draft.creditAmount || ''));
  params.set('quotaCredits', String(draft.quotaCredits || ''));
  params.set('dailyOfferLimit', String(draft.dailyOfferLimit || ''));
  for (const categoryId of draft.scopeCategoryIds) {
    params.append('scopeCategoryIds', categoryId);
  }
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
