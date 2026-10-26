import { RequestDeliveryMode, ServiceRequestQuestionSystemField } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNeighborhoodForOnSite,
  REQUEST_NEIGHBORHOOD_REQUIRED_CODE,
} from '../src/common/request-neighborhood-rule';
import { hasSystemFieldValue } from '../src/modules/questions/question-system-fields';

/*
 * The shipped list has a neighbourhood for every district today, so the one
 * controlled exception — a district whose list is really empty — can only be
 * reached by standing in for the list. Everything else reads the real one.
 */
const emptyDistricts = vi.hoisted(() => new Set<string>());

vi.mock('../src/modules/locations/turkey-locations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/locations/turkey-locations')>();
  return {
    ...actual,
    listNeighborhoods: (city: string, district: string) =>
      emptyDistricts.has(`${city}/${district}`) ? [] : actual.listNeighborhoods(city, district),
  };
});


afterEach(() => {
  emptyDistricts.clear();
});

const KADIKOY = { city: 'İstanbul', district: 'Kadıköy' };

function refusal(run: () => unknown): Record<string, unknown> | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<string, unknown>;
  }
}

describe('SERVICE-AREA-001 — assertNeighborhoodForOnSite', () => {
  it('is satisfied by a named neighbourhood, and never asks REMOTE', () => {
    expect(
      assertNeighborhoodForOnSite({ deliveryMode: RequestDeliveryMode.ON_SITE, ...KADIKOY, neighborhood: 'Caferağa Mah' }),
    ).toBe('SATISFIED');
    for (const neighborhood of [null, undefined, '', '  ']) {
      expect(
        assertNeighborhoodForOnSite({ deliveryMode: RequestDeliveryMode.REMOTE, ...KADIKOY, neighborhood }),
      ).toBe('SATISFIED');
    }
  });

  it('refuses ON_SITE without one, with its own code and the field it names', () => {
    for (const neighborhood of [null, undefined, '', '  ']) {
      expect(
        refusal(() => assertNeighborhoodForOnSite({ deliveryMode: RequestDeliveryMode.ON_SITE, ...KADIKOY, neighborhood })),
      ).toMatchObject({ code: REQUEST_NEIGHBORHOOD_REQUIRED_CODE, field: 'neighborhood' });
    }
  });

  it('lets ON_SITE through district-wide only where the district really has no neighbourhood listed', () => {
    emptyDistricts.add('İstanbul/Kadıköy');
    expect(
      assertNeighborhoodForOnSite({ deliveryMode: RequestDeliveryMode.ON_SITE, ...KADIKOY, neighborhood: null }),
    ).toBe('DISTRICT_HAS_NO_NEIGHBORHOODS');
    // A sibling district with a list is still asked.
    expect(
      refusal(() =>
        assertNeighborhoodForOnSite({
          deliveryMode: RequestDeliveryMode.ON_SITE,
          city: 'İstanbul',
          district: 'Beşiktaş',
          neighborhood: null,
        }),
      ),
    ).toMatchObject({ code: REQUEST_NEIGHBORHOOD_REQUIRED_CODE });
  });
});

describe('SERVICE-AREA-001 — the ADDRESS binding shares the exception', () => {
  const base = {
    ...KADIKOY,
    neighborhood: null,
    budgetMin: null,
    budgetMax: null,
    description: null,
    preferredDate: null,
  };

  it('is unmet without a neighbourhood, and met by the district where none is listed', () => {
    expect(hasSystemFieldValue(ServiceRequestQuestionSystemField.ADDRESS, base)).toBe(false);
    emptyDistricts.add('İstanbul/Kadıköy');
    expect(hasSystemFieldValue(ServiceRequestQuestionSystemField.ADDRESS, base)).toBe(true);
  });
});
