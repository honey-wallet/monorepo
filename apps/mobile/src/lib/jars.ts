import { priceOf } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/** A Honey Jar: crypto set aside for a goal. In memory for now. */
export type Jar = {
  id: string;
  name: string;
  symbol: string;
  goal: number;
  saved: number;
  /** Part of the demo portfolio, so a brand-new wallet doesn't show it. */
  demo?: boolean;
};

export const jars = createStore<Jar[]>(
  [{ id: 'trip', name: 'Japan trip', symbol: 'USDC', goal: 1500, saved: 420, demo: true }],
  { persist: 'jars' },
);

export const useJars = jars.useValue;

export function addJar(jar: Omit<Jar, 'id' | 'saved'>) {
  const id = `jar-${Date.now()}`;
  jars.set((prev) => [...prev, { ...jar, id, saved: 0 }]);
  return id;
}

/** The tokens a jar can hold. */
export const JAR_TOKENS = ['USDC', 'USDT', 'ETH', 'BTC'] as const;

/** Dollar value of an amount of `symbol`, at the placeholder market price. */
export function usdValue(symbol: string, amount: number) {
  return amount * priceOf(symbol);
}

/** How full a jar is, from 0 to 1. */
export function jarProgress(jar: Jar) {
  return jar.goal > 0 ? Math.min(jar.saved / jar.goal, 1) : 0;
}

/** Apply a completed movement by stable id, never by a user-editable label. */
export function moveJar(id: string, amount: number) {
  jars.set((list) =>
    list.map((jar) => (jar.id === id ? { ...jar, saved: Math.max(0, jar.saved + amount) } : jar)),
  );
}
