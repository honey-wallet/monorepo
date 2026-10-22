import type { ReactNode } from 'react';

/** Honey for Chrome: no account sign-in (see lib/identity.web.ts). */
export function IdentityProvider({ children }: { children: ReactNode }) {
  return children;
}
