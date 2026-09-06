/**
 * How a provider's service area reads, and which areas may sit beside it.
 *
 * A service area is a province, optionally narrowed to a district and then to a
 * neighbourhood. Three scopes, and each one covers everything under it: "all of
 * İstanbul" already includes Kadıköy, which already includes Moda.
 *
 * The rules live here so the web application form, the admin screens and the
 * provider's own profile print the same sentence and refuse the same
 * combination. The API enforces the identical rules against the stored data in
 * `apps/api/src/common/provider-service-area-scope.ts` — a second copy on
 * purpose, because the API cannot import this package at runtime, and because
 * what a browser refuses is a convenience while what the API refuses is the
 * guarantee. Any change here is a change there.
 */

export type ServiceAreaScope = 'CITY' | 'DISTRICT' | 'NEIGHBORHOOD';

export type ServiceAreaLike = {
  city: string;
  district?: string | null;
  neighborhood?: string | null;
};

/** Turkish-aware case folding, so "KADIKÖY" and "Kadıköy" are one place. */
function fold(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('tr-TR');
}

export function serviceAreaScope(area: ServiceAreaLike): ServiceAreaScope {
  if (!area.district) return 'CITY';
  if (!area.neighborhood) return 'DISTRICT';
  return 'NEIGHBORHOOD';
}

/**
 * The label a person reads: "İstanbul geneli", "Kadıköy, İstanbul",
 * "Moda, Kadıköy, İstanbul" — narrowest level first, the way an address is said
 * out loud in Turkish.
 */
export function serviceAreaLabel(area: ServiceAreaLike): string {
  if (!area.district) return `${area.city} geneli`;
  if (!area.neighborhood) return `${area.district}, ${area.city}`;
  return `${area.neighborhood}, ${area.district}, ${area.city}`;
}

/** Whether `outer` already reaches everywhere `inner` does. An area covers itself. */
export function serviceAreaCovers(outer: ServiceAreaLike, inner: ServiceAreaLike): boolean {
  if (fold(outer.city) !== fold(inner.city)) return false;
  if (outer.district && fold(outer.district) !== fold(inner.district)) return false;
  if (outer.neighborhood && fold(outer.neighborhood) !== fold(inner.neighborhood)) return false;
  return true;
}

/**
 * Why a candidate may not join the areas already chosen, in the words the
 * provider reads — or null when it may.
 *
 * Three answers, because they are three different mistakes, and "geçersiz
 * bölge" for all of them would leave the provider guessing which.
 */
export function serviceAreaRejectionReason(
  existing: readonly ServiceAreaLike[],
  candidate: ServiceAreaLike,
): string | null {
  for (const area of existing) {
    const sameArea = serviceAreaCovers(area, candidate) && serviceAreaCovers(candidate, area);
    if (sameArea) {
      // The area already in the list, not the candidate: both name the same
      // place, and this one is the canonical spelling the provider is looking at.
      return `${serviceAreaLabel(area)} zaten ekli.`;
    }

    if (serviceAreaCovers(area, candidate)) {
      return `${serviceAreaLabel(area)} bu bölgeyi zaten kapsıyor.`;
    }

    if (serviceAreaCovers(candidate, area)) {
      return `${serviceAreaLabel(candidate)}, ekli olan ${serviceAreaLabel(area)} bölgesini kapsıyor. Önce onu kaldırın.`;
    }
  }

  return null;
}
