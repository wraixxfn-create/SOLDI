/**
 * A ~90-line observable store.
 *
 * Deliberately not a framework: `get`, `set`, `subscribe`, plus slice subscriptions so a 60 fps loop
 * can patch one part of the state and only re-render the panels that care. Every listener is called
 * with the previous and next value so a subscriber can skip work cheaply.
 */
export type Listener<T> = (next: T, previous: T) => void;
export type Unsubscribe = () => void;

export interface Store<T> {
  get(): T;
  set(next: T | ((previous: T) => T)): void;
  /** Replaces part of the state (shallow merge at the top level) and notifies subscribers. */
  patch(partial: Partial<T>): void;
  subscribe(listener: Listener<T>): Unsubscribe;
  /** Subscribes to one field; the listener only runs when that field changes by reference. */
  select<K extends keyof T>(key: K, listener: Listener<T[K]>): Unsubscribe;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  const sliceListeners = new Map<keyof T, Set<Listener<unknown>>>();

  const notify = (next: T, previous: T): void => {
    for (const listener of [...listeners]) listener(next, previous);
    for (const [key, set] of sliceListeners) {
      if (next[key] === previous[key]) continue;
      for (const listener of [...set]) {
        (listener as Listener<T[typeof key]>)(next[key], previous[key]);
      }
    }
  };

  return {
    get: () => state,
    set(next) {
      const previous = state;
      const value = typeof next === 'function' ? (next as (p: T) => T)(previous) : next;
      if (value === previous) return;
      state = value;
      notify(state, previous);
    },
    patch(partial) {
      const previous = state;
      const value = { ...previous, ...partial };
      state = value;
      notify(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(key, listener) {
      let set = sliceListeners.get(key);
      if (!set) {
        set = new Set();
        sliceListeners.set(key, set);
      }
      set.add(listener as Listener<unknown>);
      return () => set?.delete(listener as Listener<unknown>);
    },
  };
}
