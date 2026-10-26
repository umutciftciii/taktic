import { requestDeliveryMode } from '@taktic/shared';

/**
 * B-02: "Mahalle belirtilmedi · <ilçe> geneli" next to an ON_SITE request's
 * place on a provider's screens. A request that names no neighbourhood reaches
 * every neighbourhood-scoped provider in its district, so the provider is told
 * the job may be anywhere in the district before spending credit on an offer.
 * Text, not colour; nothing for a request that names a neighbourhood or for a
 * REMOTE one, whose place does not decide who sees it.
 */
export function DistrictWideLocationTag({
  request,
}: {
  request: { deliveryMode?: string | null; district: string; neighborhood?: string | null };
}) {
  if (requestDeliveryMode(request) === 'REMOTE') return null;
  if (request.neighborhood?.trim()) return null;
  return (
    <span className="tag tag-neutral" data-testid="district-wide-location-tag">
      Mahalle belirtilmedi · {request.district} geneli
    </span>
  );
}
