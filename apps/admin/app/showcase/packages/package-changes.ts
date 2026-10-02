import { formatMinorAsTurkishLira, parseTurkishLiraToMinor } from '@taktic/shared';
import type { ShowcaseCardKind, ShowcasePackage } from '../../../lib/api';

/**
 * What a vitrin-package save changes that a business pays for
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A) — one function for the save
 * button, which asks when it finds a change, and for
 * `updateShowcasePackageAction`, which demands the
 * `showcase-package.update-commercial` proof when it finds one against the
 * package it has just read from the API.
 *
 * Commercial: the price, the run length, how long an unused right stays
 * valid, the card kind and the area cap — what a purchase buys. Not
 * commercial: the name, the description and the listing order.
 */

export type ShowcasePackageTerms = Pick<
  ShowcasePackage,
  'priceAmount' | 'currency' | 'durationDays' | 'activationWindowDays' | 'allowedCardKind' | 'maxAreas'
>;

export type ShowcaseTermsChange = { key: string; label: string; from: string; to: string };

/** Client-safe copy of `SHOWCASE_CARD_KIND_LABELS` (lib/api is server-only). */
const CARD_KIND_LABELS: Record<ShowcaseCardKind, string> = {
  SERVICE: 'Hizmet vitrini',
  PROMOTION: 'Genel tanıtım',
};

export function cardKindLabel(kind: ShowcaseCardKind | null): string {
  return kind ? CARD_KIND_LABELS[kind] ?? kind : 'Her ikisi';
}

function areasLabel(maxAreas: number | null): string {
  return maxAreas === null ? 'tüm bölgeler' : `en fazla ${maxAreas} bölge`;
}

export function showcasePackageTermsChanges(stored: ShowcasePackageTerms, next: ShowcasePackageTerms): ShowcaseTermsChange[] {
  const changes: ShowcaseTermsChange[] = [];
  if (stored.priceAmount !== next.priceAmount) {
    changes.push({
      key: 'price',
      label: 'Yayın bedeli',
      from: formatMinorAsTurkishLira(stored.priceAmount, stored.currency),
      to: formatMinorAsTurkishLira(next.priceAmount, next.currency),
    });
  }
  if (stored.durationDays !== next.durationDays) {
    changes.push({ key: 'duration', label: 'Yayın süresi', from: `${stored.durationDays} gün`, to: `${next.durationDays} gün` });
  }
  if (stored.activationWindowDays !== next.activationWindowDays) {
    changes.push({
      key: 'window',
      label: 'Kullanılmamış hakkın geçerliliği',
      from: `${stored.activationWindowDays} gün`,
      to: `${next.activationWindowDays} gün`,
    });
  }
  if ((stored.allowedCardKind ?? null) !== (next.allowedCardKind ?? null)) {
    changes.push({ key: 'kind', label: 'Kart tipi', from: cardKindLabel(stored.allowedCardKind), to: cardKindLabel(next.allowedCardKind) });
  }
  if ((stored.maxAreas ?? null) !== (next.maxAreas ?? null)) {
    changes.push({ key: 'areas', label: 'Bölge', from: areasLabel(stored.maxAreas), to: areasLabel(next.maxAreas) });
  }
  return changes;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalInt(data: FormData, name: string): number | null {
  const raw = formText(data, name);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The terms as the form will post them, with the same parsing the action applies. */
export function readShowcaseTerms(data: FormData, currency: string): ShowcasePackageTerms {
  return {
    priceAmount: parseTurkishLiraToMinor(formText(data, 'priceAmount')) ?? 0,
    currency,
    durationDays: Number.parseInt(formText(data, 'durationDays'), 10),
    activationWindowDays: Number.parseInt(formText(data, 'activationWindowDays'), 10),
    allowedCardKind: (formText(data, 'allowedCardKind') || null) as ShowcaseCardKind | null,
    maxAreas: optionalInt(data, 'maxAreas'),
  };
}

