import { useSyncExternalStore } from 'react';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';

/**
 * A toast on screen. Each show() gets a fresh id. `top` when a tray was open as it
 * showed (the name is older than the behaviour): it then sits above the tray's footer
 * buttons, and keeps that place while the tray closes rather than jumping.
 */
/** `error`: something didn't work; it shows a warning instead of the check. */
export type Toast = { id: number; message: string; top: boolean; error?: boolean };

/** Newest first. Up to three stay visible, stacked; a fourth sends the oldest out. */
const MAX_STACK = 3;

let toasts: Toast[] = [];
let nextId = 1;
let traysOpen = 0;

/** A tray opened (components/sheets/Tray.tsx); call the returned function when it closes. */
export function trayOpened() {
  traysOpen++;
  return () => {
    traysOpen--;
  };
}
const listeners = new Set<() => void>();

function set(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

/** Shows a short confirmation, e.g. "Address copied", then hides it. */
export function showToast(message: string, ms = 1800, error = false) {
  const id = nextId++;
  set([{ id, message, top: traysOpen > 0, error }, ...toasts].slice(0, MAX_STACK));
  setTimeout(() => set(toasts.filter((t) => t.id !== id)), ms);
}

/** The same pill when something failed: a few words, a warning icon (review: errors showed a check). */
export function showErrorToast(message: string, ms = 2400) {
  showToast(message, ms, true);
}

/** Removes a toast early, e.g. when it's swiped away. */
export function dismissToast(id: number) {
  set(toasts.filter((t) => t.id !== id));
}

/**
 * Confirms an action that doesn't run yet, e.g. "Demo: nothing was sent". One
 * helper, so every placeholder action is easy to find when real ones land.
 */
export function showDemoToast(what: string) {
  tap();
  // review: a few words, like every toast. Before: showToast(`Demo: ${what}`)
  void what;
  showToast(demoLabel('Demo only, nothing sent', 'Done'));
}

/** The toasts on screen, newest first. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
