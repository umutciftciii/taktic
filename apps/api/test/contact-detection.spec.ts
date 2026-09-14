import { describe, expect, it } from 'vitest';
import { detectContactDetails as apiDetect } from '../src/common/contact-detection';
import { detectContactDetails as sharedDetect } from '@taktic/shared';

const POSITIVE: Array<[string, 'phone' | 'email' | 'url']> = [
  ['Beni 0532 123 45 67 arayın', 'phone'],
  ['+90 (532) 123-45-67', 'phone'],
  ['5321234567 whatsapp', 'phone'],
  ['0212 555 44 33 sabit', 'phone'],
  ['+90 (532) 123 45 67', 'phone'],
  ['0532-123-45-67', 'phone'],
  ['05321234567 whatsapp', 'phone'],
  ['Daire 7 0532 123 45 67', 'phone'],
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
];

describe('api detectContactDetails', () => {
  it.each(POSITIVE)('flags %s as %s', (text, kind) => {
    expect(apiDetect(text)?.kind).toBe(kind);
  });

  it.each(NEGATIVE)('leaves %s alone', (text) => {
    expect(apiDetect(text)).toBeNull();
  });

  // The API cannot import the shared package's TypeScript at runtime (see the
  // header comment on ../src/common/contact-detection.ts), so it keeps its
  // own copy of the function body. This guards the one thing that matters:
  // both copies must agree on every case above, not just individually pass.
  it.each([...POSITIVE.map(([text]) => text), ...NEGATIVE])(
    'agrees with the shared implementation on %s',
    (text) => {
      expect(apiDetect(text)).toEqual(sharedDetect(text));
    },
  );
});
