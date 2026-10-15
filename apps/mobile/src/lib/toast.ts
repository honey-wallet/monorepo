import { useSyncExternalStore } from 'react';
import { tap } from '@/lib/haptics';

/** The toast currently on screen, if any. Each show() gets a fresh id. */
type Toast = { id: number; message: string } | null;

let current: Toast = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(toast: Toast) {
  current = toast;
  for (const listener of listeners) listener();
}

/** Shows a short confirmation, e.g. "Address copied", then hides it. */
export function showToast(message: string, ms = 1800) {
  clearTimeout(timer);
  set({ id: nextId++, message });
  timer = setTimeout(() => set(null), ms);
}

/**
 * Confirms an action that doesn't run yet, e.g. "Demo: nothing was sent". One
 * helper, so every placeholder action is easy to find when real ones land.
 */
export function showDemoToast(what: string) {
  tap();
  showToast(`Demo: ${what}`);
}

export function useToast(): Toast {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
