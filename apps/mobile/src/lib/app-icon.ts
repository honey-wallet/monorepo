import { requireOptionalNativeModule } from 'expo';

export type AppIconName = 'Midnight' | 'Graphite' | null;

// Optional so Expo Go and web can still open the wallet without this native module.
const native = requireOptionalNativeModule<{
  supportsAlternateIcons: boolean;
  getAppIconName(): string | null;
  setAlternateAppIcon(name: AppIconName): Promise<string | null>;
}>('ExpoAlternateAppIcons');

export const supportsAppIcons = native?.supportsAlternateIcons === true;

export function getAppIcon(): AppIconName {
  const name = native?.getAppIconName();
  return name === 'Midnight' || name === 'Graphite' ? name : null;
}

/** The OS persists the choice; never claim success before the native call completes. */
export async function changeAppIcon(name: AppIconName): Promise<AppIconName> {
  if (!native || !supportsAppIcons) throw new Error('App icons are unavailable.');
  try {
    await native.setAlternateAppIcon(name);
  } catch (error) {
    // iOS can apply the icon, then fail to present its confirmation alert.
    // Only report success when the OS confirms the exact requested icon.
    if (native.getAppIconName() === name) return name;
    throw error;
  }
  return name;
}
