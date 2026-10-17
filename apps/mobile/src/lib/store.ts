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
    // Named like a hook so the React Compiler treats it as one. Called `use`, it reads as
    // React's `use()`, which may be skipped, and the compiler memoized it away on re-render
    // (AppGate crashed on launch with a changed hook order).
    useValue: () => useSyncExternalStore(subscribe, () => state),
  };
}
