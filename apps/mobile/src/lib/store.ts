import { useSyncExternalStore } from 'react';

/**
 * A tiny in-memory store for app state shared across screens. Nothing is persisted
 * yet, so it resets when the app restarts.
 */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, () => state),
  };
}
