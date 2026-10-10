import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfferPins } from '../app/offers/offer-pins';

/**
 * ADMIN-PINNED-LABEL-001 — the offer list's pins are named from the API's
 * `context`, so a page with no row (a refund filter that matched nothing, a
 * page past the last) still reads the business and the request. The pins take
 * no rows at all: there is nothing on the page for them to depend on.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const PROVIDER = 'cmprovider000000000000001';
const REQUEST = 'cmrequest0000000000000001';
const hrefs = { unpinProviderHref: '/offers?requestId=x', unpinRequestHref: '/offers?providerId=y' };
const named = {
  provider: { id: PROVIDER, businessName: 'Usta Tesisat' },
  request: { id: REQUEST, requestNumber: 'TR-1', city: 'İzmir', district: 'Bornova', category: { name: 'Tesisat' } },
};

describe('OfferPins', () => {
  it('draws nothing with no pin', () => {
    expect(html(<OfferPins providerId="" requestId="" context={{ provider: null, request: null }} {...hrefs} />)).toBe('');
  });

  it('names the pinned provider and request from the context, never their ids', () => {
    const markup = html(<OfferPins providerId={PROVIDER} requestId={REQUEST} context={named} {...hrefs} />);
    expect(markup).toContain('HV: Usta Tesisat');
    expect(markup).toContain('Tesisat · İzmir/Bornova');
    expect(markup).not.toContain(PROVIDER);
    expect(markup).not.toContain(REQUEST);
    expect(markup).toContain('aria-label="Hizmet veren sabitlemesini kaldır"');
    expect(markup).toContain('aria-label="Talep sabitlemesini kaldır"');
  });

  it('falls back to the id only for a pin the API could not name', () => {
    const markup = html(
      <OfferPins providerId={PROVIDER} requestId={REQUEST} context={{ provider: null, request: null }} {...hrefs} />,
    );
    expect(markup).toContain(`<code class="cell-break">${PROVIDER}</code>`);
    expect(markup).toContain(`<code class="cell-break">${REQUEST}</code>`);
  });

  it('does not put another entity’s name on a pin', () => {
    const markup = html(
      <OfferPins providerId="cmother" requestId="cmotherrequest" context={named} {...hrefs} />,
    );
    expect(markup).not.toContain('Usta Tesisat');
    expect(markup).not.toContain('Bornova');
    expect(markup).toContain('<code class="cell-break">cmother</code>');
  });
});
