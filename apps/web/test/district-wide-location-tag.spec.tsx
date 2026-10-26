import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DistrictWideLocationTag } from '../app/request-fields/district-wide-location-tag';
import { NEIGHBORHOOD_SCOPE_MATCHING_HINT } from '../app/providers/service-area-matching-hint';

/**
 * B-02 — a provider is told when an on-site request named no neighbourhood,
 * and only then, because such a request reaches every neighbourhood provider
 * in its district.
 */

function tag(request: { deliveryMode?: string | null; district: string; neighborhood?: string | null }) {
  return renderToStaticMarkup(<DistrictWideLocationTag request={request} />);
}

describe('DistrictWideLocationTag', () => {
  it('labels an on-site request with no neighbourhood as district-wide', () => {
    const html = tag({ deliveryMode: 'ON_SITE', district: 'Kadıköy', neighborhood: null });
    expect(html).toContain('Mahalle belirtilmedi · Kadıköy geneli');
    expect(html).toContain('data-testid="district-wide-location-tag"');
  });

  it('reads a missing delivery mode and a blank neighbourhood the same way', () => {
    expect(tag({ district: 'Kadıköy', neighborhood: '  ' })).toContain('Kadıköy geneli');
    expect(tag({ district: 'Kadıköy' })).toContain('Kadıköy geneli');
  });

  it('prints nothing for a request that named a neighbourhood, or a remote one', () => {
    expect(tag({ deliveryMode: 'ON_SITE', district: 'Kadıköy', neighborhood: 'Caferağa Mah' })).toBe('');
    expect(tag({ deliveryMode: 'REMOTE', district: 'Kadıköy', neighborhood: null })).toBe('');
  });
});

describe('the service-area hint', () => {
  it('says a neighbourhood area takes district-wide requests, and nothing from other districts', () => {
    expect(NEIGHBORHOOD_SCOPE_MATCHING_HINT).toContain('mahalle belirtilmeden');
    expect(NEIGHBORHOOD_SCOPE_MATCHING_HINT).toContain('Başka ilçelerin talepleri gösterilmez.');
  });
});
