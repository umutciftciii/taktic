import { describe, expect, it } from 'vitest';
import { detectContactDetails } from './contact-detection';

const POSITIVE: Array<[string, 'phone' | 'email' | 'url']> = [
  ['Beni 0532 123 45 67 arayın', 'phone'],
  ['+90 (532) 123-45-67', 'phone'],
  ['5321234567 whatsapp', 'phone'],
  ['0212 555 44 33 sabit', 'phone'],
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
];

describe('detectContactDetails', () => {
  it.each(POSITIVE)('flags %s as %s', (text, kind) => {
    expect(detectContactDetails(text)?.kind).toBe(kind);
  });

  it.each(NEGATIVE)('leaves %s alone', (text) => {
    expect(detectContactDetails(text)).toBeNull();
  });
});
