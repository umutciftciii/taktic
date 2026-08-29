import { describe, expect, it } from 'vitest';
import { decodeRouterSelections, encodeRouterSelections } from '../lib/request-flow';

/**
 * How a routed flow's steps survive the trip between screens.
 *
 * This runs on the server: the page reads the parameter and the submit action
 * decodes it before posting. What matters is that a parameter somebody edited
 * by hand degrades to "no routing yet" rather than to a crash or to a step the
 * customer never took — the API re-walks every step it is given, so a decoded
 * value is a claim to be checked, never an instruction.
 */
describe('router selection encoding', () => {
  it('round-trips the steps in order', () => {
    const selections = [
      { questionKey: 'alan', optionKey: 'beyaz_esya' },
      { questionKey: 'cihaz', optionKey: 'camasir' },
    ];

    expect(decodeRouterSelections(encodeRouterSelections(selections))).toEqual(selections);
  });

  it('reads an absent parameter as no routing', () => {
    expect(decodeRouterSelections(undefined)).toEqual([]);
    expect(decodeRouterSelections(null)).toEqual([]);
    expect(decodeRouterSelections('')).toEqual([]);
  });

  it('reads malformed JSON as no routing rather than throwing', () => {
    expect(decodeRouterSelections('{oops')).toEqual([]);
    expect(decodeRouterSelections('"a string"')).toEqual([]);
    expect(decodeRouterSelections('{"questionKey":"cihaz"}')).toEqual([]);
  });

  it('drops entries that are not a question/option pair', () => {
    const raw = JSON.stringify([
      ['cihaz', 'camasir'],
      ['sadece-bir-eleman'],
      [42, 'camasir'],
      ['cihaz', null],
      { questionKey: 'cihaz', optionKey: 'bulasik' },
    ]);

    expect(decodeRouterSelections(raw)).toEqual([{ questionKey: 'cihaz', optionKey: 'camasir' }]);
  });
});
