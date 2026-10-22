import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import type { ReactNode } from 'react';
import { CLERK_PUBLISHABLE_KEY, IDENTITY_ENABLED } from '@/lib/identity';

/**
 * Clerk, when this build has a publishable key. Its session token is kept in the
 * Keychain / Keystore (expo-secure-store); wallet secrets live in the vault, never here.
 */
export function IdentityProvider({ children }: { children: ReactNode }) {
  if (!IDENTITY_ENABLED) return children;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      {children}
    </ClerkProvider>
  );
}
