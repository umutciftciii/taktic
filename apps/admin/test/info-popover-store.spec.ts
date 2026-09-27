import { describe, expect, it, vi } from 'vitest';
import { createSingleOpenStore } from '../lib/info-popover-store';

/** ADMIN-DESIGN-001 Faz 2 — "only one ⓘ open at a time". */
describe('info popover store', () => {
  it('starts closed', () => {
    expect(createSingleOpenStore().get()).toBeNull();
  });

  it('opening one closes whichever was open', () => {
    const store = createSingleOpenStore();
    store.open('a');
    store.open('b');
    expect(store.get()).toBe('b');
  });

  it('clicking the open one again closes it', () => {
    const store = createSingleOpenStore();
    store.toggle('a');
    expect(store.get()).toBe('a');
    store.toggle('a');
    expect(store.get()).toBeNull();
    store.toggle('a');
    store.toggle('b');
    expect(store.get()).toBe('b');
  });

  it('close(id) closes only that popover; close() closes any', () => {
    const store = createSingleOpenStore();
    store.open('a');
    store.close('b');
    expect(store.get()).toBe('a');
    store.close('a');
    expect(store.get()).toBeNull();
    store.open('b');
    store.close();
    expect(store.get()).toBeNull();
  });

  it('notifies subscribers only on a real change, and stops after unsubscribe', () => {
    const store = createSingleOpenStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.open('a');
    store.open('a');
    store.close('b');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.close();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
