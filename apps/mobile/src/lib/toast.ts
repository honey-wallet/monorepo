import { useSyncExternalStore } from 'react';
import { tap } from '@/lib/haptics';

/**
 * A toast on screen. Each show() gets a fresh id. `top` when a tray was open as it
 * showed: trays rise from the bottom, where the toast would cover the tray's title, and
 * it keeps that place while the tray closes rather than jumping.
 */
export type Toast = { id: number; message: string; top: boolean };

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
export function showToast(message: string, ms = 1800) {
  const id = nextId++;
  set([{ id, message, top: traysOpen > 0 }, ...toasts].slice(0, MAX_STACK));
  setTimeout(() => set(toasts.filter((t) => t.id !== id)), ms);
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
  showToast(`Demo: ${what}`);
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
