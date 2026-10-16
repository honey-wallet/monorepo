import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Asks for Face ID / Touch ID / fingerprint, falling back to the device passcode.
 * Resolves true when confirmed, or when the device has no lock at all (there's
 * nothing stronger to ask for). Used before showing a secret or signing.
 */
export async function confirmOwner(reason: string): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return true;
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
  return result.success;
}
