import { type Href, router } from 'expo-router';
import { useEffect } from 'react';
import { createStore } from '@/lib/store';

export type GuideName = 'predict' | 'perps';

const ROUTES: Record<GuideName, Href> = {
  predict: '/predict-guide',
  perps: '/perps-guide',
};

/** Guides already shown; in memory, so they show again after a restart. */
const seen = createStore<Record<GuideName, boolean>>({ predict: false, perps: false });

/** Opens a product's how-to guide. */
export function openGuide(name: GuideName) {
  seen.set((prev) => ({ ...prev, [name]: true }));
  router.push(ROUTES[name]);
}

/** Shows a product's guide the first time its screen opens, then never again. */
export function useGuideOnFirstVisit(name: GuideName) {
  useEffect(() => {
    if (seen.get()[name]) return;
    // Let the tab finish appearing before the sheet slides up over it.
    const timer = setTimeout(() => openGuide(name), 400);
    return () => clearTimeout(timer);
  }, [name]);
}
