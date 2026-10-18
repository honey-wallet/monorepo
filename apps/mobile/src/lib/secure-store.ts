import * as SecureStore from 'expo-secure-store';

/**
 * Where the app keeps secrets. On a phone: the iOS Keychain / Android Keystore, kept on
 * this device only (not in iCloud or Google backups). In a browser, `secure-store.web.ts`
 * replaces this file with a password-locked vault.
 */

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const getItemAsync = (key: string) => SecureStore.getItemAsync(key, OPTIONS);
export const setItemAsync = (key: string, value: string) =>
  SecureStore.setItemAsync(key, value, OPTIONS);
export const deleteItemAsync = (key: string) => SecureStore.deleteItemAsync(key, OPTIONS);
