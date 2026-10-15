import { priceOf } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/** A Honey Jar: crypto set aside for a goal. In memory for now. */
export type Jar = { id: string; name: string; symbol: string; goal: number; saved: number };

export const jars = createStore<Jar[]>([
  { id: 'trip', name: 'Japan trip', symbol: 'USDC', goal: 1500, saved: 420 },
]);

export const useJars = jars.use;

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
