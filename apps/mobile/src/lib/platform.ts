import { Platform } from 'react-native';

/**
 * Honey runs on phones and, from the same code, as Honey for Chrome. Phone-only
 * features (camera, Face ID, app icons, haptics, iCloud) check `isWeb`, and copy that
 * names the device uses `HERE`.
 */
export const isWeb = Platform.OS === 'web';

/** Where the wallet lives, for copy: "It stays on this phone." */
export const HERE = isWeb ? 'this browser' : 'this phone';

/** The user's device, for copy: "safe on your phone." */
export const DEVICE = isWeb ? 'your computer' : 'your phone';
