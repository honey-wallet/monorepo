import { randomAvatarSeed } from '@/components/Avatar';
import { createStore } from '@/lib/store';

/**
 * The signed-in user's profile, set at the end of onboarding.
 *
 * Not sent to the server. On the phone it lives in memory and resets when the app
 * restarts; in the browser extension it's saved so the popup remembers it.
 */
export type Profile = {
  name: string;
  photo: string | null;
  /** DiceBear seed for the generated avatar, used when there's no photo. */
  avatarSeed: string;
  haptics: boolean;
};

const profile = createStore<Profile>(
  {
    name: 'Honey',
    photo: null,
    avatarSeed: randomAvatarSeed(),
    haptics: true,
  },
  { persist: 'profile' },
);

export function setProfile(update: Partial<Profile>) {
  profile.set((p) => ({ ...p, ...update }));
}

export function getProfile(): Profile {
  return profile.get();
}

export const useProfile = profile.useValue;
