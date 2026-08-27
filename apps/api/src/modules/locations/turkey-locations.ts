import {
  getCities,
  getDistrictsOfEachCity,
  getNeighbourhoodsByCityCodeAndDistrict,
} from 'turkey-neighbourhoods';

/**
 * Turkey's administrative divisions, as one canonical list the whole product
 * shares.
 *
 * The data comes from `turkey-neighbourhoods` (MIT), which republishes the
 * Turkish Post's own postal-code list — provinces, districts and
 * neighbourhoods — as a versioned npm package. It is pinned in package.json
 * like any other dependency, so the list a deployment validates against is the
 * list that deployment shipped with; nothing here reaches the network, and no
 * third-party service sits between a customer and a submitted request.
 *
 * Everything below is derived once, at module load, from that package. The API
 * is the only place the full set lives: the request form is handed the
 * provinces and their districts (~14 KB) and asks for a district's
 * neighbourhoods when one is chosen, so the browser never carries the 73k-row
 * neighbourhood table.
 */

export type ProvinceWithDistricts = {
  /** The two-digit plate code, unique per province and stable over time. */
  code: string;
  name: string;
  districts: string[];
};

export type ResolvedLocation = {
  city: string;
  district: string;
  neighborhood: string | null;
};

/**
 * The same triple with the district left open.
 *
 * A provider's service area may name a province and nothing else, and the
 * matching rule reads that as "the whole province" — `ProviderServiceArea`
 * stores a nullable district precisely so it can. Requests have no such shape:
 * their district is required, which is why {@link resolveLocation} keeps its
 * narrower return type.
 */
export type ResolvedArea = {
  city: string;
  district: string | null;
  neighborhood: string | null;
};

/**
 * The lookup key for a name the caller typed, pasted or posted.
 *
 * Canonical names are what gets stored, so this only has to absorb the
 * differences that are not real differences: surrounding and repeated
 * whitespace, and letter case. Case-folding is Turkish-aware — "İSTANBUL"
 * lowercases to "istanbul" only under tr-TR — and the dotless "ı" is folded
 * onto "i" afterwards so a keyboard without Turkish layout ("Istanbul", which
 * tr-TR lowercases to "ıstanbul") still resolves. Folding does not merge two
 * genuinely different names: no two provinces, and no two districts of one
 * province, share a folded key.
 */
export function foldLocationName(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i');
}

type ProvinceIndex = {
  province: ProvinceWithDistricts;
  /** folded district name -> canonical district name */
  districts: Map<string, string>;
};

const provinces: ProvinceWithDistricts[] = buildProvinces();
const provinceIndex: Map<string, ProvinceIndex> = buildProvinceIndex(provinces);

function buildProvinces(): ProvinceWithDistricts[] {
  const districtsOfEachCity = getDistrictsOfEachCity() as Record<string, string[]>;

  return getCities()
    .map((city) => ({
      code: city.code,
      name: city.name,
      districts: [...(districtsOfEachCity[city.code] ?? [])].sort((a, b) =>
        a.localeCompare(b, 'tr-TR'),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr-TR'));
}

function buildProvinceIndex(source: ProvinceWithDistricts[]): Map<string, ProvinceIndex> {
  const index = new Map<string, ProvinceIndex>();

  for (const province of source) {
    const districts = new Map<string, string>();
    for (const district of province.districts) {
      districts.set(foldLocationName(district), district);
    }
    index.set(foldLocationName(province.name), { province, districts });
  }

  return index;
}

/** Every province with its districts. Safe to hand straight to a client. */
export function listProvinces(): ProvinceWithDistricts[] {
  return provinces;
}

/** The districts of one province, or an empty list when the province is unknown. */
export function listDistricts(city: string): string[] {
  return provinceIndex.get(foldLocationName(city))?.province.districts ?? [];
}

/**
 * The neighbourhoods of one district, or an empty list when the province or the
 * district is unknown — an unknown pair is not an error to report, it is simply
 * a pair with nothing under it.
 */
export function listNeighborhoods(city: string, district: string): string[] {
  const entry = provinceIndex.get(foldLocationName(city));
  if (!entry) return [];

  const canonicalDistrict = entry.districts.get(foldLocationName(district));
  if (!canonicalDistrict) return [];

  return [...getNeighbourhoodsByCityCodeAndDistrict(entry.province.code, canonicalDistrict)].sort(
    (a, b) => a.localeCompare(b, 'tr-TR'),
  );
}

/**
 * Resolves a province/district/neighbourhood triple to its canonical spelling,
 * or null when the triple does not exist.
 *
 * The relation is what is checked, not just membership: a district has to be a
 * district *of that province*, and a neighbourhood has to be a neighbourhood
 * *of that district*. "İstanbul / Çankaya" names two real places and is still
 * rejected, because Çankaya is in Ankara.
 *
 * The neighbourhood is optional — the form does not require one — but a
 * neighbourhood that was supplied and does not belong to the district is a
 * rejection, never a silently dropped field.
 */
export function resolveLocation(input: {
  city: string;
  district: string;
  neighborhood?: string | null;
}): ResolvedLocation | null {
  const area = resolveArea(input);

  // A request always names a district, so an area that resolved to a province
  // alone is not a location a request may be stored at.
  if (!area || area.district === null) return null;

  return { city: area.city, district: area.district, neighborhood: area.neighborhood };
}

/**
 * The same resolution with the district optional, for a provider service area.
 *
 * A province on its own resolves — that is how a provider says "all of
 * İstanbul", and the matching rule already reads a null district that way. A
 * district that was given still has to belong to the province, and a
 * neighbourhood still has to belong to the district (and cannot be given
 * without one: a neighbourhood floating under a whole province names no place).
 */
export function resolveArea(input: {
  city: string;
  district?: string | null;
  neighborhood?: string | null;
}): ResolvedArea | null {
  const entry = provinceIndex.get(foldLocationName(input.city ?? ''));
  if (!entry) return null;

  const rawDistrict = input.district?.trim() ?? '';
  const rawNeighborhood = input.neighborhood?.trim() ?? '';

  if (!rawDistrict) {
    if (rawNeighborhood) return null;
    return { city: entry.province.name, district: null, neighborhood: null };
  }

  const district = entry.districts.get(foldLocationName(rawDistrict));
  if (!district) return null;

  if (!rawNeighborhood) {
    return { city: entry.province.name, district, neighborhood: null };
  }

  const folded = foldLocationName(rawNeighborhood);
  const neighborhood = getNeighbourhoodsByCityCodeAndDistrict(entry.province.code, district).find(
    (candidate) => foldLocationName(candidate) === folded,
  );

  if (!neighborhood) return null;

  return { city: entry.province.name, district, neighborhood };
}
