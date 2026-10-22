import type { ReactNode } from 'react';

/** Honey for Chrome: no Clerk (see lib/identity.web.ts). */
export function IdentityProvider({ children }: { children: ReactNode }) {
  return children;
}
