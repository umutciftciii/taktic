/**
 * "Only one ⓘ open at a time", as a tiny external store.
 *
 * The design keeps a single `info` state for the whole screen: opening one
 * popover closes whichever was open, and clicking the open one again closes
 * it. Every `InfoPopover` subscribes to the same store (through
 * `useSyncExternalStore`), so that rule holds across components that know
 * nothing about each other — a header ⓘ and a filter ⓘ included.
 *
 * Kept free of React and the DOM so the rule itself is unit-tested in node.
 */

type Listener = () => void;

export type SingleOpenStore = {
  get: () => string | null;
  subscribe: (listener: Listener) => () => void;
  open: (id: string) => void;
  toggle: (id: string) => void;
  /** Closes `id` if it is the open one; with no id, closes whatever is open. */
  close: (id?: string) => void;
};

export function createSingleOpenStore(): SingleOpenStore {
  let openId: string | null = null;
  const listeners = new Set<Listener>();

  function set(next: string | null) {
    if (next === openId) return;
    openId = next;
    for (const listener of listeners) listener();
  }

  return {
    get: () => openId,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (id) => set(id),
    toggle: (id) => set(openId === id ? null : id),
    close: (id) => {
      if (id === undefined || openId === id) set(null);
    },
  };
}

export const infoPopoverStore = createSingleOpenStore();
