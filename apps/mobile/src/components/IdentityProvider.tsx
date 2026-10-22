import type { User } from '@supabase/supabase-js';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { IDENTITY_ENABLED } from '@/lib/identity';
import { identityClient } from '@/lib/identity-client';

type IdentityState = { loaded: boolean; user: User | null };

const IdentityContext = createContext<IdentityState>({ loaded: !IDENTITY_ENABLED, user: null });

/** The signed-in Supabase user, if any (screens read it through `useIdentity`). */
export const useIdentityState = () => useContext(IdentityContext);

/**
 * Supabase Auth, when this build is configured for it. Its session is kept encrypted on
 * this device (lib/session-storage.ts); wallet secrets live in the vault, never here.
 */
export function IdentityProvider({ children }: { children: ReactNode }) {
  if (!IDENTITY_ENABLED) return children;
  return <SupabaseIdentity>{children}</SupabaseIdentity>;
}

function SupabaseIdentity({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({ loaded: false, user: null });
  useEffect(() => {
    // Fires INITIAL_SESSION first (the stored session, or none), then every change.
    const { data } = identityClient().auth.onAuthStateChange((_event, session) => {
      setState({ loaded: true, user: session?.user ?? null });
    });
    return () => data.subscription.unsubscribe();
  }, []);
  return <IdentityContext.Provider value={state}>{children}</IdentityContext.Provider>;
}
