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
  const entry = provinceIndex.get(foldLocationName(input.city ?? ''));
  if (!entry) return null;

  const district = entry.districts.get(foldLocationName(input.district ?? ''));
  if (!district) return null;

  const rawNeighborhood = input.neighborhood?.trim() ?? '';
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
