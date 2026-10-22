import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { IDENTITY_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/identity';
import { encryptedSessionStorage } from '@/lib/session-storage';

/**
 * The Supabase Auth client, created on first use and only when IDENTITY_ENABLED. It is
 * used for sign-in alone: no tables are read or written from the app, and nothing
 * key-related ever goes through it.
 */
let client: SupabaseClient | null = null;

export function identityClient(): SupabaseClient {
  if (!IDENTITY_ENABLED) throw new Error('Sign-in isn’t configured in this build.');
  if (client) return client;
  const created = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: encryptedSessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Redirects come back through expo-web-browser, never as a page URL.
      detectSessionInUrl: false,
      // Google returns a one-time code exchanged with a verifier kept on this device,
      // so no tokens ride in the redirect URL.
      flowType: 'pkce',
    },
  });
  // Supabase's React Native guidance: refresh tokens only while the app is in front.
  if (AppState.currentState === 'active') void created.auth.startAutoRefresh();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void created.auth.startAutoRefresh();
    else void created.auth.stopAutoRefresh();
  });
  client = created;
  return created;
}
