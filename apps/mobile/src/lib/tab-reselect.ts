// Tapping the tab you're already on brings its screen back to the top, as in every
// iOS app. The tab bar announces the tap; each tab's screen listens for its own name.
import { useEffect, useRef } from 'react';

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

/** Called by the tab bar when its current tab is tapped again. */
export function reselectTab(name: string) {
  for (const listener of listeners.get(name) ?? []) listener();
}

/** Runs `onReselect` (e.g. scroll to the top) when this tab is tapped while showing. */
export function useTabReselect(name: string | undefined, onReselect: Listener) {
  const latest = useRef(onReselect);
  latest.current = onReselect;
  useEffect(() => {
    if (!name) return;
    const listener = () => latest.current();
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return () => {
      set.delete(listener);
    };
  }, [name]);
}
