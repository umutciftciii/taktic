import { ProviderServiceAreaScope } from '@prisma/client';
import { foldLocationName } from '../modules/locations/turkey-locations';

/**
 * The canonical comparison key for one showcase card area.
 *
 * Two areas are the same place when their keys are equal, and that is the only
 * definition of sameness this feature has: the unique index on
 * `(cardVersionId, areaKey)`, the subset test that decides whether an edit is a
 * narrowing, and the audit row that lists what a narrowing removed all read it.
 *
 * Three properties, all load-bearing:
 *
 * 1. **Folded with the location table's own rule.** `foldLocationName` is what
 *    resolves a typed place name to a canonical one, so "KADIKÖY", "Kadıköy"
 *    and "kadikoy" produce one key. Using a different fold here would let two
 *    spellings of one district count as two areas.
 * 2. **The empty string, never NULL, for a level an area does not name.**
 *    PostgreSQL treats NULLs as distinct in a unique index, so a key assembled
 *    from nullable parts would bind no duplicates at all — the mistake
 *    `ProviderServiceArea` needed three partial indexes to undo. One non-null
 *    text column needs one ordinary unique index.
 * 3. **Derived on the server, always.** No request body carries a key. A client
 *    that could post one could claim that "İstanbul geneli" and
 *    "İstanbul/Kadıköy" are the same area, or that they are different ones.
 *
 * The separator is a character no Turkish place name contains, which is what
 * makes the three segments unambiguous — and what the `area_key_shape` CHECK in
 * the migration verifies about every stored row.
 */
export const SHOWCASE_AREA_KEY_SEPARATOR = '|';

export type ShowcaseAreaLevels = {
  city: string;
  district: string | null;
  neighborhood: string | null;
};

export function showcaseAreaKey(area: ShowcaseAreaLevels): string {
  return [
    foldLocationName(area.city),
    area.district ? foldLocationName(area.district) : '',
    area.neighborhood ? foldLocationName(area.neighborhood) : '',
  ].join(SHOWCASE_AREA_KEY_SEPARATOR);
}

/**
 * The scope a card area carries, worked out from the levels it names.
 *
 * Identical in meaning to `serviceAreaScopeOf` for a provider's own coverage,
 * and deliberately a separate function rather than a shared one: this returns
 * the scope for a *card* area, the database CHECK that reads it is a different
 * constraint on a different table, and a single helper serving both would make
 * a change for one silently apply to the other.
 */
export function showcaseAreaScopeOf(area: ShowcaseAreaLevels): ProviderServiceAreaScope {
  if (!area.district) return ProviderServiceAreaScope.CITY;
  if (!area.neighborhood) return ProviderServiceAreaScope.DISTRICT;
  return ProviderServiceAreaScope.NEIGHBORHOOD;
}

/** The row shape a card area is written with — scope and key included. */
export function toShowcaseAreaRow(area: ShowcaseAreaLevels) {
  return {
    scope: showcaseAreaScopeOf(area),
    city: area.city,
    district: area.district,
    neighborhood: area.neighborhood,
    areaKey: showcaseAreaKey(area),
  };
}
