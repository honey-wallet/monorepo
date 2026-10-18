import { useSyncExternalStore } from 'react';
import { persistence } from '@/lib/persistence';

/**
 * A tiny store for app state shared across screens. In memory on the phone, so it resets
 * when the app restarts. A store given a `persist` key is also saved in a browser, where
 * the extension's popup starts afresh every time it opens (see persistence.web.ts).
 */
export function createStore<T>(initial: T, options?: { persist?: string }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const store = {
    subscribe,
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      if (options?.persist) persistence.save(options.persist, state);
      for (const listener of listeners) listener();
    },
    // Named like a hook so the React Compiler treats it as one. Called `use`, it reads as
    // React's `use()`, which may be skipped, and the compiler memoized it away on re-render
    // (AppGate crashed on launch with a changed hook order).
    useValue: () => useSyncExternalStore(subscribe, () => state),
  };
  if (options?.persist) {
    persistence.register(options.persist, (saved) => {
      state = saved as T;
      for (const listener of listeners) listener();
    });
  }
  return store;
}
