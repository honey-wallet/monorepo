import { type Backup, decryptBackup, encryptBackup, isBackup } from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { confirmOwner } from '@/lib/auth';
import { createStore } from '@/lib/store';
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

export type CloudProvider = 'icloud' | 'gdrive';

/** Where each provider lives in the share sheet, so the user knows what to tap. */
export const PROVIDERS: Record<CloudProvider, { name: string; tip: string }> = {
  icloud: {
    name: 'iCloud Drive',
    tip: 'When the share sheet opens, tap Save to Files, then iCloud Drive.',
  },
  gdrive: {
    name: 'Google Drive',
    tip:
      Platform.OS === 'ios'
        ? 'When the share sheet opens, tap Drive. Don’t see it? Install Google Drive first.'
        : 'When the share sheet opens, tap Drive.',
  },
};

/** iPhones can use either; Android has no iCloud. */
export const AVAILABLE: CloudProvider[] = Platform.OS === 'ios' ? ['icloud', 'gdrive'] : ['gdrive'];

/** Every place a backup can live, for copy like "From iCloud Drive or Google Drive". */
export const CLOUD_NAMES = AVAILABLE.map((p) => PROVIDERS[p].name).join(' or ');

/** The provider picked for the next backup, and where the last one went. */
export const backupPrefs = createStore<{ provider: CloudProvider; savedTo: CloudProvider | null }>({
  provider: AVAILABLE[0] ?? 'gdrive',
  savedTo: null,
});
export const useBackupPrefs = backupPrefs.useValue;

export const setBackupProvider = (provider: CloudProvider) =>
  backupPrefs.set((prev) => ({ ...prev, provider }));

const FILE_NAME = 'Honey wallet backup.json';

/** Encrypts the device's phrase and opens the share sheet to save it to `provider`. */
export async function saveBackupFile(password: string, provider: CloudProvider) {
  if (!(await confirmOwner('Export your recovery phrase'))) return false;
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
      dialogTitle: `Save your backup to ${PROVIDERS[provider].name}`,
    });
  } finally {
    // The share sheet has made its own copy; don't leave one lying in the cache.
    file.delete();
  }
  // Sharing cannot distinguish saving from cancellation. Verify a user-selected copy.
  const saved = await pickBackupFile();
  if (!saved) return false;
  if ((await decryptBackup(saved, password)) !== phrase) {
    throw new Error('That backup belongs to a different recovery phrase');
  }
  backupPrefs.set((prev) => ({ ...prev, savedTo: provider }));
  return true;
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
    if (file.size > 16 * 1024) throw new Error('Backup file is too large');
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
