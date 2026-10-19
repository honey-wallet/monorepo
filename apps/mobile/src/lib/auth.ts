import * as LocalAuthentication from 'expo-local-authentication';
import { AppState } from 'react-native';

let prompts = 0;

/** Browser only (auth.web.ts): the phone checks its owner with Face ID, not a password. */
export const checkPassword = async (_password: string) => false;

export const isAuthenticatingOwner = () => prompts > 0;

/** Authenticate with biometrics or the device passcode; backgrounding cancels the result.
 * Sensitive actions fail closed unless the caller explicitly opts out.
 */
export async function confirmOwner(reason: string, requireDeviceLock = true): Promise<boolean> {
  let cancelled = AppState.currentState === 'background';
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background') cancelled = true;
  });
  prompts++;
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (cancelled) return false;
    if (level === LocalAuthentication.SecurityLevel.NONE) return !requireDeviceLock;
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
    return result.success && !cancelled;
  } finally {
    prompts--;
    sub.remove();
  }
}
