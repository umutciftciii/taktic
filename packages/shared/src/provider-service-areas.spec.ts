import { describe, expect, it } from 'vitest';
import {
  serviceAreaCovers,
  serviceAreaLabel,
  serviceAreaRejectionReason,
  serviceAreaScope,
} from './provider-service-areas';

const ISTANBUL = { city: 'İstanbul', district: null, neighborhood: null };
const KADIKOY = { city: 'İstanbul', district: 'Kadıköy', neighborhood: null };
const MODA = { city: 'İstanbul', district: 'Kadıköy', neighborhood: 'Caferağa Mah' };

describe('serviceAreaScope', () => {
  it('reads the scope off the levels that were named', () => {
    expect(serviceAreaScope(ISTANBUL)).toBe('CITY');
    expect(serviceAreaScope(KADIKOY)).toBe('DISTRICT');
    expect(serviceAreaScope(MODA)).toBe('NEIGHBORHOOD');
  });
});

describe('serviceAreaLabel', () => {
  it('says what the scope means, narrowest level first', () => {
    expect(serviceAreaLabel(ISTANBUL)).toBe('İstanbul geneli');
    expect(serviceAreaLabel(KADIKOY)).toBe('Kadıköy, İstanbul');
    expect(serviceAreaLabel(MODA)).toBe('Caferağa Mah, Kadıköy, İstanbul');
  });
});

describe('serviceAreaCovers', () => {
  it('has the wider area covering everything under it', () => {
    expect(serviceAreaCovers(ISTANBUL, KADIKOY)).toBe(true);
    expect(serviceAreaCovers(ISTANBUL, MODA)).toBe(true);
    expect(serviceAreaCovers(KADIKOY, MODA)).toBe(true);
  });

  it('does not have a narrower area covering a wider one', () => {
    expect(serviceAreaCovers(KADIKOY, ISTANBUL)).toBe(false);
    expect(serviceAreaCovers(MODA, KADIKOY)).toBe(false);
  });

  it('has every area covering itself, whatever the spelling', () => {
    expect(serviceAreaCovers(ISTANBUL, { city: 'istanbul' })).toBe(true);
    expect(serviceAreaCovers(KADIKOY, { city: 'İSTANBUL', district: 'KADIKÖY' })).toBe(true);
  });

  it('does not reach across a sibling', () => {
    expect(serviceAreaCovers(KADIKOY, { city: 'İstanbul', district: 'Beşiktaş' })).toBe(false);
    expect(serviceAreaCovers(ISTANBUL, { city: 'Ankara', district: 'Çankaya' })).toBe(false);
  });
});

describe('serviceAreaRejectionReason', () => {
  it('lets an unrelated area in', () => {
    expect(serviceAreaRejectionReason([KADIKOY], { city: 'Ankara' })).toBeNull();
    expect(
      serviceAreaRejectionReason([KADIKOY], { city: 'İstanbul', district: 'Beşiktaş' }),
    ).toBeNull();
  });

  it('names the area that is already there', () => {
    expect(serviceAreaRejectionReason([KADIKOY], { city: 'istanbul', district: 'kadıköy' })).toBe(
      'Kadıköy, İstanbul zaten ekli.',
    );
  });

  it('names the wider area that already covers the candidate', () => {
    expect(serviceAreaRejectionReason([ISTANBUL], KADIKOY)).toBe(
      'İstanbul geneli bu bölgeyi zaten kapsıyor.',
    );
  });

  it('names what the candidate would swallow, and says to remove it first', () => {
    expect(serviceAreaRejectionReason([MODA], ISTANBUL)).toBe(
      'İstanbul geneli, ekli olan Caferağa Mah, Kadıköy, İstanbul bölgesini kapsıyor. Önce onu kaldırın.',
    );
  });

  it('checks the candidate against every area, not only the first', () => {
    expect(serviceAreaRejectionReason([{ city: 'Ankara' }, ISTANBUL], MODA)).toBe(
      'İstanbul geneli bu bölgeyi zaten kapsıyor.',
    );
  });

  it('lets the first area of an empty list in', () => {
    expect(serviceAreaRejectionReason([], MODA)).toBeNull();
  });
});
