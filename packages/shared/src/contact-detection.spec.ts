import { describe, expect, it } from 'vitest';
import { detectContactDetails } from './contact-detection';

const POSITIVE: Array<[string, 'phone' | 'email' | 'url']> = [
  ['Beni 0532 123 45 67 arayın', 'phone'],
  ['+90 (532) 123-45-67', 'phone'],
  ['5321234567 whatsapp', 'phone'],
  ['0212 555 44 33 sabit', 'phone'],
  ['+90 (532) 123 45 67', 'phone'],
  ['0532-123-45-67', 'phone'],
  ['05321234567 whatsapp', 'phone'],
  ['Daire 7 0532 123 45 67', 'phone'],
  ['12.03.2026 tarihinde 0532 123 45 67', 'phone'],
  ['05 32 12 34 567', 'phone'],
  ['0532.123.45.67', 'phone'],
  ['+90.532.123.45.67', 'phone'],
  ['Bütçe 50.000 TL 0532 123 45 67', 'phone'],
  ['mail: ali@example.com', 'email'],
  ['ali [at] example [dot] com', 'email'],
  ['ali (at) example.com', 'email'],
  ['https://example.com/ilan', 'url'],
  ['www.example.com', 'url'],
  ['wa.me/905321234567', 'url'],
  ['t.me/aliusta', 'url'],
  ['siteme bakın aliusta.com', 'url'],
];

const NEGATIVE = [
  'Bütçem 15000 TL',
  'Tarih 12.03.2026',
  'Posta kodu 34000',
  '10.000.000 TL üstü olmasın',
  'No: 12 Kat 3 Daire 7',
  '3+1 daire, 120 m2',
  'IBAN son 4: 1234',
  'Sabah 09:30 ile 12:00 arası',
  '@usta değil, sizinle konuşmak istiyorum',
  '2 oda 1 salon 85 m2 2018 yapımı',
  'Bütçem 50.000 - 60.000 TL arası',
  '500.000 - 600.000 TL',
  '90.000 - 100.000 TL',
  '5.000.000 - 6.000.000 TL',
  '₺5.000.000–₺6.000.000',
  '50000-60000 lira',
  'Bütçe 15000 TL, en fazla 20000',
  '2 oda 1 salon 120 m2 2018 yapımı 3. kat',
  '15.09.2026 - 20.09.2026 arası müsaitim',
  'Metrekare 90 100 110 120 130',
  'IBAN TR33 0006 1005 1978 6457 8413 26',
  '5 000 000 - 6 000 000 TL',
];

/**
 * 2500 single-digit tokens in one separator-joined run — the worst case for
 * anything that enumerates slices of a run. Must stay far from the request
 * path's budget: the check runs on every public POST and on every keystroke
 * in the form.
 */
const DIGIT_SPAM = Array.from({ length: 2500 }, () => '1').join(' ');

describe('detectContactDetails', () => {
  it.each(POSITIVE)('flags %s as %s', (text, kind) => {
    expect(detectContactDetails(text)?.kind).toBe(kind);
  });

  it.each(NEGATIVE)('leaves %s alone', (text) => {
    expect(detectContactDetails(text)).toBeNull();
  });

  it('stays fast on a run of thousands of digit tokens', () => {
    const startedAt = performance.now();
    expect(detectContactDetails(DIGIT_SPAM)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(200);
  });
});
