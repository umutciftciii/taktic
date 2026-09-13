import { describe, expect, it } from 'vitest';
import { forwardedForHeaders } from '../lib/forwarded-for';

/**
 * The web never invents a client address. With the trusted-proxy flag off it
 * forwards nothing; with it on it forwards exactly the header it received,
 * because that header was written by the edge and the API's own trust-proxy
 * hop count is what picks the real client out of it.
 */
describe('forwardedForHeaders', () => {
  it('forwards nothing when the web is not behind a trusted proxy', () => {
    expect(forwardedForHeaders('1.2.3.4, 5.6.7.8', false)).toEqual({});
  });

  it('forwards the received header verbatim when it is', () => {
    expect(forwardedForHeaders('1.2.3.4, 5.6.7.8', true)).toEqual({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
  });

  it('never synthesises a header', () => {
    expect(forwardedForHeaders(null, true)).toEqual({});
    expect(forwardedForHeaders('   ', true)).toEqual({});
  });
});
