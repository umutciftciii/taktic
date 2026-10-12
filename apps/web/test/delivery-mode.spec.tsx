import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServiceAreaDeliveryNote } from '../app/providers/service-area-delivery-note';
import { DeliveryModeBadge } from '../app/request-fields/delivery-mode-badge';
import { DeliveryModeField } from '../app/request-fields/delivery-mode-field';
import { requestContentRows } from '../lib/request-content';
import { buildServiceRequestPayload } from '../lib/service-request-payload';

/**
 * MATCH-001 — the customer's and the provider's side of the delivery mode:
 * what the form asks (only for HYBRID) and posts, what a REMOTE request says
 * next to its place, and what the area picker says about remote services. An
 * ON_SITE category or request renders exactly what it did before.
 */

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

const BASE = { categorySlug: 'online-ders', city: 'Ankara', district: 'Çankaya', questionMeta: '[]' };

describe('buildServiceRequestPayload', () => {
  it('posts the HYBRID choice, and nothing when the form asked nothing or carried garbage', () => {
    expect(buildServiceRequestPayload(form({ ...BASE, deliveryMode: 'REMOTE' })).deliveryMode).toBe('REMOTE');
    expect(buildServiceRequestPayload(form({ ...BASE, deliveryMode: 'ON_SITE' })).deliveryMode).toBe('ON_SITE');
    expect(buildServiceRequestPayload(form(BASE))).not.toHaveProperty('deliveryMode');
    expect(buildServiceRequestPayload(form({ ...BASE, deliveryMode: 'BOTH' }))).not.toHaveProperty('deliveryMode');
  });
});

describe('DeliveryModeField', () => {
  it('HYBRID: a required, unticked pair of labelled radios', () => {
    const html = renderToStaticMarkup(<DeliveryModeField model="HYBRID" value={null} onChange={() => {}} />);
    expect(html).toContain('<legend>Hizmet şekli *</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('Yerinde hizmet');
    expect(html).toContain('Uzaktan hizmet');
    // Each option's description is tied to its radio.
    expect(html).toContain('aria-describedby="delivery-mode-REMOTE-hint"');
    expect(html).toContain('id="delivery-mode-REMOTE-hint"');
    expect(html).not.toContain('delivery-mode-remote-note');
  });

  it('HYBRID answered REMOTE, and a REMOTE category, say the place does not limit matching; ON_SITE renders nothing', () => {
    const hybridRemote = renderToStaticMarkup(<DeliveryModeField model="HYBRID" value="REMOTE" onChange={() => {}} />);
    expect(hybridRemote).toContain('checked=""');
    expect(hybridRemote).toContain('delivery-mode-remote-note');

    const remote = renderToStaticMarkup(<DeliveryModeField model="REMOTE" value={null} onChange={() => {}} />);
    expect(remote).not.toContain('type="radio"');
    expect(remote).toContain('sınırlamaz');

    expect(renderToStaticMarkup(<DeliveryModeField model="ON_SITE" value={null} onChange={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<DeliveryModeField model={undefined} value={null} onChange={() => {}} />)).toBe('');
  });

  it('associates an API refusal with the group', () => {
    const html = renderToStaticMarkup(
      <DeliveryModeField model="HYBRID" value={null} onChange={() => {}} error="Seçim gerekli." />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="delivery-mode-error"');
    expect(html).toContain('id="delivery-mode-error"');
  });
});

describe('a REMOTE request on screen', () => {
  it('the provider badge is text and only for REMOTE', () => {
    expect(renderToStaticMarkup(<DeliveryModeBadge request={{ deliveryMode: 'REMOTE' }} />)).toContain('Uzaktan');
    expect(renderToStaticMarkup(<DeliveryModeBadge request={{ deliveryMode: 'ON_SITE' }} />)).toBe('');
    expect(renderToStaticMarkup(<DeliveryModeBadge request={{}} />)).toBe('');
  });

  it('the customer content block adds a "Hizmet şekli" row for REMOTE only', () => {
    const remote = requestContentRows({ city: 'Ankara', district: 'Çankaya', deliveryMode: 'REMOTE' });
    expect(remote.map((row) => [row.label, row.value])).toEqual([
      ['Hizmet şekli', 'Uzaktan hizmet'],
      ['Konum', 'Ankara, Çankaya'],
    ]);
    expect(requestContentRows({ city: 'Ankara', district: 'Çankaya', deliveryMode: 'ON_SITE' }).map((row) => row.label)).toEqual([
      'Konum',
    ]);
  });
});

describe('ServiceAreaDeliveryNote', () => {
  it('names the remote and hybrid services, and is absent for an all-ON_SITE list', () => {
    const html = renderToStaticMarkup(
      <ServiceAreaDeliveryNote
        categories={[
          { name: 'Online Ders', deliveryModel: 'REMOTE' },
          { name: 'Danışmanlık', deliveryModel: 'HYBRID' },
          { name: 'Klima', deliveryModel: 'ON_SITE' },
        ]}
      />,
    );
    expect(html).toContain('Online Ders');
    expect(html).toContain('Danışmanlık');
    expect(html).not.toContain('Klima');
    expect(renderToStaticMarkup(<ServiceAreaDeliveryNote categories={[{ name: 'Klima' }]} />)).toBe('');
  });
});
