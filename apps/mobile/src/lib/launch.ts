import { createStore } from '@/lib/store';

/**
 * Whether the opening animation has started uncovering the app. Screens hold their
 * entrances until then, so they play as the overlay fades rather than behind it.
 */
const revealed = createStore(false);

export const revealApp = () => revealed.set(true);
export const useAppRevealed = revealed.useValue;
