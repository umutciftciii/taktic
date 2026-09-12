import { describe, expect, it } from 'vitest';
import { buildServiceRequestPayload } from '../lib/service-request-payload';

/**
 * The one place a posted form becomes the API's request body.
 *
 * Both the marketplace form and the vitrin card's form post through this, so
 * the properties below are the contract they share: the location travels as
 * the three canonical fields, the timing is the select's own value, a blank
 * optional field is null rather than an empty string, and the answers are
 * exactly the questions the form said it rendered.
 */
function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      data.append(key, item);
    }
  }
  return data;
}

describe('buildServiceRequestPayload', () => {
  it('maps the vitrin card form onto the request body the API takes', () => {
    const payload = buildServiceRequestPayload(
      form({
        categorySlug: 'klima-servisi',
        customerName: 'Ayşe Yılmaz',
        customerPhone: '05551234567',
        customerEmail: 'ayse@example.test',
        city: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: '',
        urgency: 'THIS_WEEK',
        description: 'Salon kliması soğutmuyor.',
        questionMeta: '[]',
      }),
    );

    expect(payload).toMatchObject({
      categorySlug: 'klima-servisi',
      routerSelections: [],
      useAlternateContact: false,
      customerName: 'Ayşe Yılmaz',
      customerPhone: '05551234567',
      customerEmail: 'ayse@example.test',
      city: 'İstanbul',
      district: 'Kadıköy',
      neighborhood: null,
      addressNote: null,
      budgetMin: null,
      budgetMax: null,
      preferredDate: null,
      urgency: 'THIS_WEEK',
      description: 'Salon kliması soğutmuyor.',
      contactDisclosureAccepted: false,
      contactDisclosureVersion: null,
      answers: [],
    });
  });

  it('leaves the contact fields out when the form never rendered them', () => {
    const payload = buildServiceRequestPayload(
      form({ categorySlug: 'x', city: 'İstanbul', district: 'Kadıköy', questionMeta: '[]' }),
    );

    expect('customerName' in payload).toBe(false);
    expect('customerPhone' in payload).toBe(false);
    expect('customerEmail' in payload).toBe(false);
  });

  it('builds the answers from the questions the form rendered, typed per question', () => {
    const payload = buildServiceRequestPayload(
      form({
        categorySlug: 'x',
        city: 'İstanbul',
        district: 'Kadıköy',
        questionMeta: JSON.stringify([
          { key: 'unit', type: 'SELECT' },
          { key: 'rooms', type: 'NUMBER' },
          { key: 'urgent', type: 'BOOLEAN' },
          { key: 'extras', type: 'MULTI_SELECT' },
        ]),
        answer_unit: 'split',
        answer_rooms: '3',
        answer_extras: ['clean', ''],
      }),
    );

    expect(payload.answers).toEqual([
      { questionKey: 'unit', value: 'split' },
      { questionKey: 'rooms', value: 3 },
      { questionKey: 'urgent', value: false },
      { questionKey: 'extras', value: ['clean'] },
    ]);
  });

  it('accepts a disclosure only as the literal "true" the checkbox posts', () => {
    const accepted = buildServiceRequestPayload(
      form({
        categorySlug: 'x',
        city: 'İstanbul',
        district: 'Kadıköy',
        questionMeta: '[]',
        contactDisclosureAccepted: 'true',
        contactDisclosureVersion: 'v2',
      }),
    );
    expect(accepted.contactDisclosureAccepted).toBe(true);
    expect(accepted.contactDisclosureVersion).toBe('v2');

    const onOnly = buildServiceRequestPayload(
      form({ categorySlug: 'x', city: 'İstanbul', district: 'Kadıköy', questionMeta: '[]', contactDisclosureAccepted: 'on' }),
    );
    expect(onOnly.contactDisclosureAccepted).toBe(false);
  });
});
