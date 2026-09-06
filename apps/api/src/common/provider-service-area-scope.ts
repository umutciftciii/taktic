import { ProviderServiceAreaScope } from '@prisma/client';
import { sameText } from './provider-request-matching';

/**
 * What a service area's scope is, and which areas may sit beside it.
 *
 * Scope is derived, never received: the API takes a province, an optional
 * district and an optional neighbourhood, and this decides what that triple
 * means. A client cannot post `scope`, so a body cannot claim "all of İstanbul"
 * while naming Kadıköy — the database CHECK that pairs the two would refuse it
 * anyway, but the field never reaches the database in the first place.
 */

export type ScopedArea = {
  city: string;
  district: string | null;
  neighborhood: string | null;
};

export function serviceAreaScopeOf(area: ScopedArea): ProviderServiceAreaScope {
  if (!area.district) return ProviderServiceAreaScope.CITY;
  if (!area.neighborhood) return ProviderServiceAreaScope.DISTRICT;
  return ProviderServiceAreaScope.NEIGHBORHOOD;
}

/** The row shape the service areas are written with, scope included. */
export function toServiceAreaRow(area: ScopedArea) {
  return {
    scope: serviceAreaScopeOf(area),
    city: area.city,
    district: area.district,
    neighborhood: area.neighborhood,
  };
}

/**
 * Whether `outer` already covers everything `inner` does.
 *
 * "İstanbul geneli" covers "İstanbul/Kadıköy" and "İstanbul/Kadıköy/Moda";
 * "İstanbul/Kadıköy" covers the third. An area covers itself, which is what
 * makes this the duplicate test as well as the containment test.
 */
export function areaCovers(outer: ScopedArea, inner: ScopedArea): boolean {
  if (!sameText(outer.city, inner.city)) return false;
  if (outer.district && !sameText(outer.district, inner.district)) return false;
  if (outer.neighborhood && !sameText(outer.neighborhood, inner.neighborhood)) return false;
  return true;
}

/** How an area reads on screen: "İstanbul geneli", "Moda, Kadıköy, İstanbul". */
export function describeArea(area: ScopedArea): string {
  if (!area.district) return `${area.city} geneli`;
  if (!area.neighborhood) return `${area.district}, ${area.city}`;
  return `${area.neighborhood}, ${area.district}, ${area.city}`;
}
