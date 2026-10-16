import { useSyncExternalStore } from 'react';
import { randomAvatarSeed } from '@/components/Avatar';

/**
 * The signed-in user's profile, set at the end of onboarding.
 *
 * In memory only for now: nothing is persisted or sent to the server, so it
 * resets when the app restarts.
 */
export type Profile = {
  name: string;
  photo: string | null;
  /** DiceBear seed for the generated avatar, used when there's no photo. */
  avatarSeed: string;
  haptics: boolean;
};

let profile: Profile = {
  name: 'Honey',
  photo: null,
  avatarSeed: randomAvatarSeed(),
  haptics: true,
};
const listeners = new Set<() => void>();

export function setProfile(update: Partial<Profile>) {
  profile = { ...profile, ...update };
  for (const listener of listeners) listener();
}

export function getProfile(): Profile {
  return profile;
}

export function useProfile(): Profile {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getProfile);
}
