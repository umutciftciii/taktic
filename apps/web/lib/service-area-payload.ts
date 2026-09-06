import type { ServiceAreaLike } from '@taktic/shared';

/**
 * The service areas a submitted provider form carries, as the API's field.
 *
 * The form posts one `serviceAreas` entry per chosen area, each holding that
 * area's JSON — so this reads them with `getAll` rather than reassembling three
 * parallel arrays that a dropped value could put out of step.
 *
 * Nothing here validates a place. A malformed entry is dropped and every
 * surviving one is passed through as the three names it claims; whether those
 * name a real province, district and neighbourhood — and whether the list holds
 * a duplicate or an area another one swallows — is decided by the API against
 * the canonical location list, because the endpoint takes a plain JSON body and
 * a browser is not what makes that true.
 */
export function readServiceAreas(formData: FormData): ServiceAreaLike[] {
  return formData
    .getAll('serviceAreas')
    .flatMap((entry) => (typeof entry === 'string' ? parseArea(entry) : []));
}

function parseArea(entry: string): ServiceAreaLike[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];

  const area = parsed as Record<string, unknown>;
  const city = typeof area.city === 'string' ? area.city.trim() : '';
  if (!city) return [];

  const district = typeof area.district === 'string' ? area.district.trim() : '';
  const neighborhood = typeof area.neighborhood === 'string' ? area.neighborhood.trim() : '';

  return [
    {
      city,
      district: district || null,
      // A neighbourhood under no district names no place, and the API refuses
      // one. Dropping it here keeps the refusal about what the provider chose.
      neighborhood: district ? neighborhood || null : null,
    },
  ];
}
