import { describe, expect, it } from 'vitest';
import {
  formatMinorAsTurkishLira,
  formatMinorAsTurkishLiraInput,
  parseTurkishLiraToMinor,
} from './money';

describe('parseTurkishLiraToMinor', () => {
  it.each([
    ['10', 1000],
    ['10,5', 1050],
    ['10,50', 1050],
    ['1.250,75', 125075],
    ['1.250', 125000],
    ['1.250.000,01', 125000001],
    ['0,01', 1],
    [' 499,90 ', 49990],
    ['₺ 499,90', 49990],
    ['1', 100],
  ])('reads %s as %d kuruş', (input, expected) => {
    expect(parseTurkishLiraToMinor(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    [',', 'separator alone'],
    ['.', 'separator alone'],
    ['0', 'zero'],
    ['0,00', 'zero'],
    ['-10', 'negative'],
    ['10,505', 'three decimals'],
    ['10.50', 'dot as decimal point'],
    ['12.50,00', 'irregular grouping'],
    ['1,250,75', 'comma grouping'],
    ['1.2500', 'irregular grouping'],
    ['abc', 'letters'],
    ['10 TL', 'text after the number'],
    ['1e3', 'exponent'],
    ['1234567890123', 'too many lira digits'],
  ])('refuses %s (%s)', (input) => {
    expect(parseTurkishLiraToMinor(input)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(parseTurkishLiraToMinor(null)).toBeNull();
    expect(parseTurkishLiraToMinor(undefined)).toBeNull();
  });

  it('never goes through floating point', () => {
    // 0.29 * 100 is 28.999999999999996 in IEEE 754; the digit shuffle is exact.
    expect(parseTurkishLiraToMinor('0,29')).toBe(29);
    expect(parseTurkishLiraToMinor('4,35')).toBe(435);
    expect(parseTurkishLiraToMinor('1,15')).toBe(115);
  });
});

describe('formatMinorAsTurkishLiraInput', () => {
  it.each([
    [1000, '10,00'],
    [1050, '10,50'],
    [125075, '1.250,75'],
    [1, '0,01'],
    [0, '0,00'],
    [125000001, '1.250.000,01'],
  ])('writes %d as %s', (minor, expected) => {
    expect(formatMinorAsTurkishLiraInput(minor)).toBe(expected);
  });

  it('writes nothing for a missing or non-integer amount', () => {
    expect(formatMinorAsTurkishLiraInput(null)).toBe('');
    expect(formatMinorAsTurkishLiraInput(undefined)).toBe('');
    expect(formatMinorAsTurkishLiraInput(10.5)).toBe('');
  });

  it('round-trips every stored amount through the parser', () => {
    for (const minor of [1, 99, 100, 1000, 1050, 49900, 125075, 999999999]) {
      expect(parseTurkishLiraToMinor(formatMinorAsTurkishLiraInput(minor))).toBe(minor);
    }
  });
});

describe('formatMinorAsTurkishLira', () => {
  it('puts the lira sign in front and the code of any other currency behind', () => {
    expect(formatMinorAsTurkishLira(1000)).toBe('₺10,00');
    expect(formatMinorAsTurkishLira(125075, 'TRY')).toBe('₺1.250,75');
    expect(formatMinorAsTurkishLira(1000, 'EUR')).toBe('10,00 EUR');
  });
});
