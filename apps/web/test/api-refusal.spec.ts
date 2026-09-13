import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { describeApiRefusal } from '../lib/api-refusal';
import { REQUEST_REFUSAL_GENERIC } from '../lib/request-refusal-text';

/**
 * How an API refusal becomes the code a form looks up. The case that earns a
 * test of its own is the code-less 403: the API says nothing but the status,
 * and the code it becomes has to name the form it happened on, or the
 * marketplace form would tell a provider a *vitrin* lead could not be sent.
 */
describe('describeApiRefusal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the code-less 403 for the form the call belongs to', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const forbidden = new ApiError(403, JSON.stringify({ statusCode: 403, message: 'Forbidden resource' }));
    expect(describeApiRefusal('service-requests', forbidden)).toEqual({ ok: false, code: 'REQUEST_FORBIDDEN', message: null });
    expect(describeApiRefusal('vitrin/cards/card-1/leads', forbidden)).toEqual({
      ok: false,
      code: 'SHOWCASE_LEAD_FORBIDDEN',
      message: null,
    });
  });

  it('keeps the API’s own code and client-worded message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = new ApiError(409, JSON.stringify({ code: 'CUSTOMER_IDENTITY_CONFLICT', message: 'Çakışma.' }));
    expect(describeApiRefusal('service-requests', refused)).toEqual({ ok: false, code: 'CUSTOMER_IDENTITY_CONFLICT', message: 'Çakışma.' });
    const broken = new ApiError(500, 'Internal Server Error');
    expect(describeApiRefusal('service-requests', broken)).toEqual({ ok: false, code: REQUEST_REFUSAL_GENERIC, message: null });
  });
});
