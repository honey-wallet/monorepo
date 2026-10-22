# Clerk setup (Sign in with Apple, Google and email)

Honey uses [Clerk](https://clerk.com) only to know **who** someone is. Recovery phrases and
keys are made and kept on the device (Keychain / Keystore), exactly as before. Clerk never
sees them, and the app writes nothing to Clerk metadata.

What the app does with a Clerk sign-in:

- **Create a new wallet:** after Apple, Google or the email code, the phone makes a new
  wallet in its own vault and opens Home. "Back up your wallet" stays on the setup
  checklist.
- **I already have a wallet:** signing in can't bring keys back, so after sign-in the
  sheet shows the restore options (backup file, recovery phrase, private key, or the
  browser extension).
- **Sign out** (Settings): erases the wallets on the device as before, and also signs out
  of Clerk.

Without a publishable key the app still works: the Apple / Google / email buttons are
hidden and the recovery-phrase and import options are shown. The browser extension never
shows them yet (see the last section).

You need: a Clerk account, an Apple Developer account (for Apple), and later a domain for
the production Clerk instance.

---

## 1. Create the Clerk application

1. Go to <https://dashboard.clerk.com> and sign up or sign in.
2. Select **Create application**. Name it `Honey Wallet`.
3. Pick the sign-in options **Email**, **Google** and **Apple**, then select
   **Create application**. This makes a **development** instance (keys start with `pk_test_`).

## 2. Turn on email codes (no passwords)

1. In the Clerk Dashboard open **User & authentication**.
2. Under **Email**: turn on **Sign-up with email** and **Sign-in with email**, choose
   **Email verification code** for both, and turn on **Verify at sign-up**.
3. Turn **Password** **off** (Honey signs in with codes only; the app can't finish a
   sign-up that asks for a password).
4. Leave first/last name **not required** (the app doesn't collect them).

## 3. Google

Development instance: nothing else to do. Open **SSO connections**, select
**Add connection → For all users → Google**, and make sure **Enable for sign-up and
sign-in** is on. Clerk's shared Google credentials work for testing.

Production instance (when you go live), you need your own Google credentials:

1. In Clerk: **SSO connections → Google**, turn on **Use custom credentials** and copy the
   **Authorized Redirect URI**.
2. In <https://console.cloud.google.com>: pick or create a project, then
   **APIs & Services → OAuth consent screen**, fill it in (app name, support email, logo).
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type
   **Web application**. Under **Authorized redirect URIs** paste the Clerk URI. Create it.
4. Paste the **Client ID** and **Client Secret** back into Clerk and save.
5. Before launch, set the consent screen's publishing status to **In production**
   (Google limits "Testing" apps to 100 test users).

Honey opens Google in the system browser sheet (Clerk's OAuth flow), so no iOS/Android
Google client IDs are needed.

## 4. Apple (native Sign in with Apple, iOS)

App Store rule: an app that offers Google sign-in must also offer Sign in with Apple. On
iPhone Honey uses Apple's native sheet. Android shows Google and email only.

1. **Apple Developer → Certificates, IDs & Profiles → Identifiers.** Open the App ID for
   bundle ID `com.honeywallet.app` (create it if missing: **+ → App IDs → App**). Make sure
   the **Sign In with Apple** capability is ticked, then save. (EAS Build also turns this on
   for you when it manages signing, because the app now ships the Sign in with Apple
   entitlement.)
2. On that App ID page copy the **App ID Prefix** (your 10-character Team ID).
3. **Clerk Dashboard → Native applications → Add iOS app.** Enter the App ID Prefix and the
   Bundle ID `com.honeywallet.app`. Save.
4. **Clerk Dashboard → SSO connections → Add connection → For all users → Apple.** Turn on
   **Enable for sign-up and sign-in**.
5. Hide My Email: in Clerk's Apple connection copy **Email Source for Apple Private Email
   Relay**. In Apple Developer go to **Services → Sign in with Apple for Email
   Communication → Configure → +** and add that address. (Without it, codes and emails to
   `@privaterelay.appleid.com` addresses don't arrive.)

The native flow does not need a Services ID or a private key. Clerk only needs those for
Apple sign-in **in a browser**. If the production instance asks for custom Apple
credentials anyway, follow Clerk's
[Apple production guide](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple#configure-for-your-production-instance).
In short: create a **Services ID** (Identifiers → + → Services IDs), enable Sign In with
Apple on it with your App ID as the primary, add Clerk's domain and **Return URL**. Then
create a **Key** (Keys → + → Sign In with Apple → your App ID) and download the `.p8` once.
Paste the Services ID, Team ID, Key ID and the key file into Clerk.

## 5. Allow the app's redirect (Google)

1. **Clerk Dashboard → Native applications → Allowlist for mobile SSO redirect.**
2. Add `honeywallet://sso-callback` and save. (Do this in the production instance too.)

## 6. Put the publishable key in the app

1. **Clerk Dashboard → API keys.** Copy the **Publishable key** (`pk_test_…` now,
   `pk_live_…` in production). It is public by design and safe to ship in the app.
   Never copy the **Secret key** anywhere in this repo.
2. Local development: in `apps/mobile/.env.local` add

   ```sh
   EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   ```

3. EAS builds and updates: add the same variable to the `preview` and `production` EAS
   environments (expo.dev → your project → **Environment variables**), using the
   `pk_live_` key for production.

## 7. Make a new build

This change adds native code (`expo-apple-authentication`, `expo-web-browser`,
`expo-auth-session`, Clerk's config plugin). Expo Go and existing dev builds don't have it,
and an OTA update can't add it. Build again:

```sh
cd apps/mobile
pnpm exec expo prebuild --clean   # only if you build locally; ios/ and android/ are generated
pnpm exec expo run:ios            # or: pnpm eas build --profile preview --platform ios
```

Then test on a real iPhone: Create a new wallet → Continue with Apple, Google and email.

## 8. Server (optional): verify Clerk sessions

The API can check a Clerk session token and return the Clerk user id at
`GET /api/v1/me/clerk` (send `Authorization: Bearer <token from Clerk getToken()>`). It is
off until both variables are set in `apps/server/.env` (or your deployment's secrets):

```sh
# Clerk Dashboard → API keys → "Frontend API URL" (no trailing slash)
CLERK_ISSUER=https://your-app.clerk.accounts.dev
# The same URL plus /.well-known/jwks.json
CLERK_JWKS_URL=https://your-app.clerk.accounts.dev/.well-known/jwks.json
# Optional: browser origins allowed in the token's azp claim (native tokens have none)
# CLERK_AUTHORIZED_PARTIES=https://wallet.example.com
```

For production use the production instance's Frontend API URL (for example
`https://clerk.yourdomain.com`). No Clerk secret key is needed: the server only uses the
public keys.

## 9. Going live checklist

1. In Clerk, create the **production** instance (needs a domain you own; follow Clerk's
   DNS steps).
2. Repeat steps 2–5 in the production instance (Google with custom credentials).
3. Use the `pk_live_` key in the production EAS environment, and the production
   `CLERK_ISSUER` / `CLERK_JWKS_URL` on the server.
4. App Store: apps that let people create an account must also let them delete it in the
   app. Plan an account-deletion path for Clerk accounts before submission.

## Browser extension

Honey for Chrome doesn't show Apple / Google / email yet. Clerk's web SDK loads its runtime
script from Clerk's servers, which a Manifest V3 extension may not do, and OAuth redirects
would leave the popup. A later version could use `@clerk/chrome-extension`. Until then the
extension keeps the recovery phrase, import and pair-with-phone options, and
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `apps/extension/.env.local` has no effect.
