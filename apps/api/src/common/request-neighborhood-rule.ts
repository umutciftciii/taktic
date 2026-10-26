import { BadRequestException } from '@nestjs/common';
import { RequestDeliveryMode } from '@prisma/client';
import { isLocationBound } from './delivery-mode';
import { listNeighborhoods } from '../modules/locations/turkey-locations';

/**
 * SERVICE-AREA-001 — a new on-site request names its neighbourhood.
 *
 * A provider's service area is a province, a district or one neighbourhood,
 * and a request that leaves the neighbourhood out cannot be held to the last
 * of the three. B-02 settled what such a request means (the whole district),
 * and that reading stays for every row already stored without one; from here
 * on the customer of an ON_SITE request is simply asked for it.
 *
 * - REMOTE: never asked. The request's place is the customer's own, and
 *   matching does not read it.
 * - HYBRID: the mode the customer chose decides, exactly as it does for
 *   matching — this reads the resolved `deliveryMode`, never the category.
 * - A district the shipped list has no neighbourhood for: the one controlled
 *   exception. Asking would refuse every customer there with nothing to pick,
 *   so the request goes through district-wide and the caller logs why.
 *
 * Only creation asks this. Reading, matching, a new round and the publish
 * fan-out all read the stored row, which is what keeps a legacy request
 * without a neighbourhood working as it always did.
 */
export const REQUEST_NEIGHBORHOOD_REQUIRED_CODE = 'REQUEST_NEIGHBORHOOD_REQUIRED';

export type NeighborhoodRuleOutcome =
  /** The request names a neighbourhood, or does not need one. */
  | 'SATISFIED'
  /** ON_SITE without one, accepted because the district has none listed. */
  | 'DISTRICT_HAS_NO_NEIGHBORHOODS';

export function assertNeighborhoodForOnSite(request: {
  deliveryMode: RequestDeliveryMode;
  city: string;
  district: string;
  neighborhood: string | null | undefined;
}): NeighborhoodRuleOutcome {
  if (!isLocationBound(request) || request.neighborhood?.trim()) {
    return 'SATISFIED';
  }

  if (listNeighborhoods(request.city, request.district).length === 0) {
    return 'DISTRICT_HAS_NO_NEIGHBORHOODS';
  }

  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: REQUEST_NEIGHBORHOOD_REQUIRED_CODE,
    field: 'neighborhood',
    message: 'Yerinde hizmet talebi için mahalle seçmelisiniz.',
  });
}
