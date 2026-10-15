import { useSyncExternalStore } from 'react';
import { FAVORITES } from '@/lib/mock-wallet';

/** Favourite tokens by ticker, shared by token pages and search. In memory for now. */
let favorites: string[] = [...FAVORITES];
const listeners = new Set<() => void>();

function set(next: string[]) {
  favorites = next;
  for (const listener of listeners) listener();
}

export function toggleFavorite(symbol: string) {
  set(favorites.includes(symbol) ? favorites.filter((s) => s !== symbol) : [...favorites, symbol]);
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
