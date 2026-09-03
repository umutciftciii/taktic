import { describe, expect, it } from 'vitest';
import {
  completeLiraAmount,
  formatLiraDraft,
  parseLiraToMinor,
} from '../lib/lira-input';

/**
 * The budget fields' one rule, stated three ways.
 *
 * What the customer types is lira. Every case below exists because getting that
 * wrong is not a formatting bug — a field that read `5000` as kuruş would post
 * a budget a hundred times too small and nothing downstream would notice.
 *
 * These are the pure functions only. That the caret survives, that the numeric
 * keypad appears and that the pair fits a 320px phone are browser claims, and
 * `e2e/tests/request-budget-inputs.spec.ts` makes them in a browser.
 */
describe('formatLiraDraft', () => {
  it('groups thousands as the number is typed', () => {
    expect(formatLiraDraft('5')).toBe('5');
    expect(formatLiraDraft('50')).toBe('50');
    expect(formatLiraDraft('500')).toBe('500');
    expect(formatLiraDraft('5000')).toBe('5.000');
    expect(formatLiraDraft('1234567')).toBe('1.234.567');
  });

  it('re-groups the digits it is handed back, grouping and all', () => {
    // What the field holds after the previous keystroke, plus one more digit.
    expect(formatLiraDraft('5.0005')).toBe('50.005');
    // And one fewer: deleting a digit regroups rather than stranding a dot.
    expect(formatLiraDraft('5.00')).toBe('500');
  });

  it('leaves the kuruş exactly as far as they have been typed', () => {
    expect(formatLiraDraft('5000,')).toBe('5.000,');
    expect(formatLiraDraft('5000,5')).toBe('5.000,5');
    expect(formatLiraDraft('5000,50')).toBe('5.000,50');
  });

  it('keeps the kuruş to two digits and the comma to one', () => {
    expect(formatLiraDraft('5000,509')).toBe('5.000,50');
    expect(formatLiraDraft('5000,5,9')).toBe('5.000,59');
  });

  it('reads a bare comma as half a lira rather than as nothing', () => {
    expect(formatLiraDraft(',')).toBe('0,');
    expect(formatLiraDraft(',5')).toBe('0,5');
  });

  it('drops what is not part of a number', () => {
    expect(formatLiraDraft('₺ 5 000')).toBe('5.000');
    expect(formatLiraDraft('1.500,00 TL')).toBe('1.500,00');
    expect(formatLiraDraft('abc')).toBe('');
    expect(formatLiraDraft('₺')).toBe('');
    expect(formatLiraDraft('')).toBe('');
  });

  it('keeps one zero rather than a row of them', () => {
    expect(formatLiraDraft('0')).toBe('0');
    expect(formatLiraDraft('00')).toBe('0');
    expect(formatLiraDraft('007')).toBe('7');
    expect(formatLiraDraft('00,50')).toBe('0,50');
  });
});

describe('completeLiraAmount', () => {
  it('pads the kuruş once the field is left', () => {
    expect(completeLiraAmount('5000')).toBe('5.000,00');
    expect(completeLiraAmount('5000,5')).toBe('5.000,50');
    expect(completeLiraAmount('5000,50')).toBe('5.000,50');
    expect(completeLiraAmount('5.000,')).toBe('5.000,00');
  });

  it('leaves an empty field empty, because the budget is optional', () => {
    expect(completeLiraAmount('')).toBe('');
    expect(completeLiraAmount('   ')).toBe('');
    expect(completeLiraAmount('₺')).toBe('');
  });

  it('is idempotent, so leaving a completed field changes nothing', () => {
    expect(completeLiraAmount(completeLiraAmount('5000'))).toBe('5.000,00');
  });

  it('completes a zero rather than discarding it', () => {
    expect(completeLiraAmount('0')).toBe('0,00');
    expect(completeLiraAmount('00')).toBe('0,00');
  });
});

describe('parseLiraToMinor', () => {
  it('reads the digits before the comma as lira', () => {
    // The whole point: five thousand lira, not fifty.
    expect(parseLiraToMinor('5.000,00')).toBe(500000);
    expect(parseLiraToMinor('5000')).toBe(500000);
    expect(parseLiraToMinor('5.000,50')).toBe(500050);
    expect(parseLiraToMinor('1,00')).toBe(100);
    expect(parseLiraToMinor('0,50')).toBe(50);
  });

  it('gives null for a field the customer did not fill in', () => {
    expect(parseLiraToMinor('')).toBeNull();
    expect(parseLiraToMinor('   ')).toBeNull();
    expect(parseLiraToMinor('₺')).toBeNull();
    expect(parseLiraToMinor(null)).toBeNull();
    expect(parseLiraToMinor(undefined)).toBeNull();
  });

  it('gives zero for an entered zero, which the API then refuses', () => {
    // Not null: the customer typed something, and "nothing entered" has to stay
    // distinguishable from "zero entered" for the API to answer either one.
    expect(parseLiraToMinor('0')).toBe(0);
    expect(parseLiraToMinor('0,00')).toBe(0);
  });

  it('never returns a negative amount, whatever the field was handed', () => {
    expect(parseLiraToMinor('-5000')).toBe(500000);
  });

  it('stays inside safe integers however many digits are pasted', () => {
    const parsed = parseLiraToMinor('9'.repeat(40));
    expect(Number.isSafeInteger(parsed!)).toBe(true);
  });
});
