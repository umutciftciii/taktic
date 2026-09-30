import type { KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { handleTablistKeyDown } from '../lib/tablist-keys';

/** Three fake tabs and a key event on one of them, the way React hands it over. */
function press(key: string, on: number) {
  const tabs = [0, 1, 2].map(() => ({ focus: vi.fn() }));
  const preventDefault = vi.fn();
  const event = {
    key,
    target: tabs[on],
    currentTarget: { querySelectorAll: () => tabs },
    preventDefault,
  } as unknown as KeyboardEvent<HTMLElement>;
  const select = vi.fn();
  handleTablistKeyDown(event, select);
  return { tabs, select, preventDefault };
}

describe('handleTablistKeyDown (Faz 4)', () => {
  it('moves right and wraps from the last tab to the first', () => {
    expect(press('ArrowRight', 0).select).toHaveBeenCalledWith(1);
    const wrapped = press('ArrowRight', 2);
    expect(wrapped.select).toHaveBeenCalledWith(0);
    expect(wrapped.tabs[0]!.focus).toHaveBeenCalled();
  });

  it('moves left and wraps from the first tab to the last', () => {
    expect(press('ArrowLeft', 1).select).toHaveBeenCalledWith(0);
    expect(press('ArrowLeft', 0).select).toHaveBeenCalledWith(2);
  });

  it('Home and End go to the ends', () => {
    expect(press('Home', 2).select).toHaveBeenCalledWith(0);
    expect(press('End', 0).select).toHaveBeenCalledWith(2);
  });

  it('leaves every other key alone — Tab still leaves the tablist', () => {
    const { select, preventDefault } = press('Tab', 1);
    expect(select).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
