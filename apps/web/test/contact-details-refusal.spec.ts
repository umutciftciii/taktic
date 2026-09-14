import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { describeApiRefusal } from '../lib/api-refusal';
import { CONTACT_DETAILS_IN_TEXT, contactDetailsTarget } from '../lib/contact-details-refusal';

/**
 * How the one field-level refusal finds its field. The API names the field
 * with the same words the form posts, and the form has to point the sentence
 * at the right control — or, for a field it cannot point at, fall back to the
 * banner rather than lose the refusal.
 */
describe('contactDetailsTarget', () => {
  it('maps the three field shapes the API names', () => {
    expect(contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT, field: 'description' })).toEqual({
      target: 'description',
    });
    expect(contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT, field: 'addressNote' })).toEqual({
      target: 'addressNote',
    });
    expect(
      contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT, field: 'answers.extra_notes' }),
    ).toEqual({ target: 'answer', questionKey: 'extra_notes' });
  });

  it('answers null for any other refusal, or a field the form has no control for', () => {
    expect(contactDetailsTarget({ code: 'CUSTOMER_IDENTITY_CONFLICT', field: 'description' })).toBeNull();
    expect(contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT })).toBeNull();
    expect(contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT, field: 'answers.' })).toBeNull();
    expect(contactDetailsTarget({ code: CONTACT_DETAILS_IN_TEXT, field: 'title' })).toBeNull();
  });
});

describe('describeApiRefusal with a field', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the API’s field and kind through to the form', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = new ApiError(
      400,
      JSON.stringify({
        statusCode: 400,
        code: CONTACT_DETAILS_IN_TEXT,
        field: 'answers.extra_notes',
        kind: 'phone',
        message: 'İletişim bilgisi paylaşılamaz.',
      }),
    );
    expect(describeApiRefusal('service-requests', refused)).toEqual({
      ok: false,
      code: CONTACT_DETAILS_IN_TEXT,
      field: 'answers.extra_notes',
      kind: 'phone',
      message: 'İletişim bilgisi paylaşılamaz.',
    });
  });

  it('adds neither key when the API named none', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = new ApiError(409, JSON.stringify({ code: 'CUSTOMER_IDENTITY_CONFLICT', message: 'Çakışma.' }));
    expect(Object.keys(describeApiRefusal('service-requests', refused))).toEqual(['ok', 'code', 'message']);
  });
});
