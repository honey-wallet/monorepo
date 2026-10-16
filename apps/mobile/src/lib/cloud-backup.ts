import { type Backup, decryptBackup, encryptBackup, isBackup } from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { readPrimaryMnemonic } from '@/lib/vault';

/**
 * The recovery phrase as a password-encrypted file the user saves to iCloud Drive or
 * Google Drive through the share sheet, and picks again to restore. Only the encrypted
 * file leaves the device; the password never does.
 *
 * TODO: write to Honey's own iCloud / Drive folder automatically (react-native-cloud-storage)
 * once there's a dev build with the iCloud container and a Google OAuth client. The file
 * format stays the same, so files saved by hand keep working.
 */

export const CLOUD = Platform.OS === 'android' ? 'Google Drive' : 'iCloud';

const FILE_NAME = 'Honey wallet backup.json';

/** Encrypts the device's phrase and opens the share sheet to save it. */
export async function saveBackupFile(password: string) {
  const phrase = await readPrimaryMnemonic();
  if (!phrase) throw new Error('This device doesn’t have a recovery phrase yet');
  const backup = await encryptBackup(phrase, password, getRandomBytes);
  const file = new File(Paths.cache, FILE_NAME);
  if (file.exists) file.delete();
  file.create();
  file.write(JSON.stringify(backup, null, 2));
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: `Save your backup to ${CLOUD}`,
    });
  } finally {
    // The share sheet has made its own copy; don't leave one lying in the cache.
    file.delete();
  }
}

/** Lets the user pick a backup file. Null if they cancel. */
export async function pickBackupFile(): Promise<Backup | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'public.json', '*/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const file = new File(result.assets[0]?.uri ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    parsed = null;
  } finally {
    if (file.exists) file.delete();
  }
  if (!isBackup(parsed)) throw new Error('That isn’t a Honey backup file');
  return parsed;
}

export { decryptBackup };
