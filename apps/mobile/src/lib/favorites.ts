import { useSyncExternalStore } from 'react';
import { FAVORITES } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';

/** Favourites fill one scrolling row on Search, so they stay a short list. */
export const MAX_FAVORITES = 5;

/** Favourite tokens by ticker, shared by token pages and search. In memory for now. */
let favorites: string[] = FAVORITES.slice(0, MAX_FAVORITES);
const listeners = new Set<() => void>();

function set(next: string[]) {
  favorites = next;
  for (const listener of listeners) listener();
}

export function toggleFavorite(symbol: string) {
  if (favorites.includes(symbol)) return set(favorites.filter((s) => s !== symbol));
  if (favorites.length >= MAX_FAVORITES) {
    showToast(`You can keep up to ${MAX_FAVORITES} favorites. Remove one first.`);
    return;
  }
  set([...favorites, symbol]);
}

/** Puts favourites in a new order (dragged on Search). */
export function reorderFavorites(next: string[]) {
  set(next);
}

export function useFavorites(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => favorites,
  );
}
