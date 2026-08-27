import { Controller, Get, Query } from '@nestjs/common';
import { listNeighborhoods, listProvinces } from './turkey-locations';

/**
 * The location list the request form is built from.
 *
 * Public on purpose: the request form is public, and these are the names of
 * Turkey's provinces, districts and neighbourhoods — the same list the Turkish
 * Post publishes. Nothing here reads or writes application data.
 */
@Controller('locations')
export class LocationsController {
  /** Every province with its districts. One response, ~14 KB, no pagination. */
  @Get('provinces')
  getProvinces() {
    return listProvinces();
  }

  /**
   * A district's neighbourhoods, asked for only once a district is chosen.
   *
   * An unknown province or district answers with an empty list rather than an
   * error: the caller is a form asking "what is under this pair", and the
   * request that matters — creating the service request — is validated on its
   * own terms and refuses an invalid pair there.
   */
  @Get('neighborhoods')
  getNeighborhoods(@Query('city') city?: string, @Query('district') district?: string) {
    if (!city?.trim() || !district?.trim()) {
      return [];
    }

    return listNeighborhoods(city, district);
  }
}
