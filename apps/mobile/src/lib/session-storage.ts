import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * Where the Supabase session lives on a phone (Supabase's "LargeSecureStore" pattern).
 * A session is larger than the Keychain / Keystore item limit (about 2 KB), so the
 * session JSON is AES-256-GCM encrypted into AsyncStorage and only its 32-byte key
 * goes into SecureStore, on this device only. The session is an account login, never
 * a wallet secret: recovery phrases and keys stay in the vault (lib/vault.ts).
 */

const SECURE = {
  // A session refresh may run while the screen is locked; it never unlocks wallet keys.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

const NONCE_BYTES = 12;

/** SecureStore keys allow only letters, digits, `.`, `-` and `_`. */
const keyName = (key: string) => `honey.identity.${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** Binds each sealed value to its storage key, so values can't be swapped between keys. */
const aad = (key: string) => new TextEncoder().encode(key);

async function encryptionKey(key: string, create: boolean): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(keyName(key), SECURE);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return hexToBytes(stored);
  if (!create) return null;
  const fresh = getRandomBytes(32);
  await SecureStore.setItemAsync(keyName(key), bytesToHex(fresh), SECURE);
  return fresh;
}

export const encryptedSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    const sealed = await AsyncStorage.getItem(key);
    if (!sealed) return null;
    const secret = await encryptionKey(key, false);
    try {
      if (!secret || !/^[0-9a-f]+$/.test(sealed) || sealed.length <= NONCE_BYTES * 2)
        throw new Error('unreadable');
      const bytes = hexToBytes(sealed);
      const plain = gcm(secret, bytes.subarray(0, NONCE_BYTES), aad(key)).decrypt(
        bytes.subarray(NONCE_BYTES),
      );
      return new TextDecoder().decode(plain);
    } catch {
      // Lost key (a restored phone) or tampered data: signed out, nothing else.
      await encryptedSessionStorage.removeItem(key);
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    const secret = await encryptionKey(key, true);
    if (!secret) throw new Error('No session key');
    const nonce = getRandomBytes(NONCE_BYTES);
    const sealed = gcm(secret, nonce, aad(key)).encrypt(new TextEncoder().encode(value));
    await AsyncStorage.setItem(key, bytesToHex(nonce) + bytesToHex(sealed));
  },

  async removeItem(key: string): Promise<void> {
    await Promise.all([
      AsyncStorage.removeItem(key),
      SecureStore.deleteItemAsync(keyName(key), SECURE),
    ]);
  },
};
