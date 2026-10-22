import type { Identity } from '@/lib/identity-flows';
import { finishOnboarding, nameFromEmail } from '@/lib/onboarding';
import { getProfile } from '@/lib/profile';
import { createAccount, loadAccounts } from '@/lib/vault';
import { addVaultWallet } from '@/lib/wallets';

export type IdentityMethod = 'apple' | 'google' | 'email';

/**
 * What happens after Apple, Google or email sign-in. The account says who the user is;
 * it never holds keys, so the wallet itself is still made or restored on this device:
 *
 *   create  → a new wallet under a new recovery phrase in this device's vault (backed
 *             up later from the setup checklist), then Home
 *   restore → the keys have to come back from a backup, a phrase or the other device,
 *             so the caller shows those ways ('needs-keys')
 *
 * A device that already holds wallets just opens them.
 */
export async function continueAfterSignIn(
  method: IdentityMethod,
  { restore, identity }: { restore: boolean; identity: Identity },
): Promise<'opened' | 'needs-keys'> {
  const name =
    identity.name || (identity.email ? nameFromEmail(identity.email) : getProfile().name);
  if ((await loadAccounts()).length === 0) {
    if (restore) return 'needs-keys';
    addVaultWallet(await createAccount(name));
  }
  finishOnboarding(method, { restored: restore, name });
  return 'opened';
}
