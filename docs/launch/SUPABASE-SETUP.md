# Supabase setup (Sign in with Apple, Google and email, plus the server database)

Honey uses [Supabase Auth](https://supabase.com/docs/guides/auth) only to know **who**
someone is. Recovery phrases and keys are made and kept on the device (Keychain /
Keystore), exactly as before. Supabase never sees them, and the app writes nothing to the
Supabase user (no metadata, no tables). The same Supabase project can also host the
server's Postgres database (section 9).

What the app does with a sign-in:

- **Create a new wallet:** after Apple, Google or the 6-digit email code, the phone makes
  a new wallet in its own vault and opens Home. "Back up your wallet" stays on the setup
  checklist.
- **I already have a wallet:** signing in can't bring keys back, so after sign-in the
  sheet says "Signed in as …" and shows the restore options (backup file, recovery phrase,
  private key, or the browser extension).
- **Sign out** (Settings): erases the wallets on the device as before, and also signs out
  of Supabase on this device.

Without `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` the app still
works: the Apple / Google / email buttons are hidden and the recovery-phrase and import
options are shown. The browser extension never shows them yet (see the last section).

You need: a Supabase account, an Apple Developer account (for Apple), a Google Cloud
account (for Google) and, before launch, an email-sending service (SMTP) and a domain.

How it works, in one line each:

- **Apple (iPhone):** Apple's native sheet gives an identity token; the app hands it to
  Supabase (`signInWithIdToken`) with a one-time nonce. Android doesn't show Apple.
- **Google:** Supabase's Google page opens in the in-app browser sheet and comes back to
  `honeywallet://auth-callback` with a one-time code (PKCE). No Google SDK in the app.
- **Email:** Supabase emails a 6-digit code (`signInWithOtp`); the app checks it
  (`verifyOtp`). An address without an account gets one.
- **On the phone** the session is encrypted in app storage and its key is in the
  Keychain / Keystore (Supabase's recommended "LargeSecureStore" pattern).

---

## 1. Create the project

1. Go to <https://supabase.com/dashboard> and sign up or sign in.
2. Select **New project**. Pick your organization, name it `Honey Wallet`, and set a
   strong **database password** (save it in your password manager; the server needs it in
   section 9).
3. **Region:** pick the one closest to where the API server will run (the server talks to
   the database on every request; users only talk to Auth when they sign in). For example
   `Central EU (Frankfurt)` or `East US (North Virginia)`. You can't move a project later.
4. Select **Create new project** and wait a minute or two.

**Plan:** the Free plan pauses a project after **1 week without activity**, and a paused
project can't sign anyone in. Use the **Pro** plan (from $25/month, never paused) before
real users arrive. Free is fine for trying things out.

## 2. Copy the project URL and key into the app

1. **Project Settings → API** (also under the **Connect** button). Copy the
   **Project URL** (`https://<project-ref>.supabase.co`).
2. Copy the **publishable key** (`sb_publishable_…`), or the legacy **anon** key if that
   is what your project shows. Either one goes in `EXPO_PUBLIC_SUPABASE_ANON_KEY`. It is
   public by design and safe to ship in the app. **Never** copy the secret /
   `service_role` key into this repo or the app.
3. Local development: in `apps/mobile/.env.local` add

   ```sh
   EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
   ```

4. EAS builds and updates: add the same two variables to the `preview` and `production`
   EAS environments (expo.dev → your project → **Environment variables**).

## 3. Turn on asymmetric JWT signing keys

The Honey server checks sign-ins with Supabase's **public** keys, so the project must sign
tokens with an asymmetric key (new projects may already do this).

1. **Project Settings → JWT Keys** (the "JWT signing keys" page).
2. If it still uses the **legacy JWT secret**, select **Migrate JWT secret**. This creates
   a new **ECC (P-256)** key in standby. Keep ECC (ES256); RSA (RS256) also works.
3. Wait at least 20 minutes (Supabase caches the public keys), then select
   **Rotate keys** so new tokens are signed with the new key. Nobody is signed out.
4. Later, after at least 1 hour 15 minutes, you can **revoke** the legacy secret.

The keys are published at `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
(you can open it in a browser; it holds public keys only).

## 4. Email: 6-digit codes, not links

1. **Authentication → Sign In / Providers → Email:** make sure **Email** is enabled. Turn
   **Confirm email** on. Honey never asks for a password.
2. **Authentication → Emails → Templates.** Supabase sends a link by default; Honey needs
   the code. Edit **both** the **Magic link** template and the **Confirm sign up** template
   (a first-time address gets the second one) so they show the code, for example:

   ```html
   <h2>Your Honey code</h2>
   <p>Enter this code in Honey Wallet: <strong>{{ .Token }}</strong></p>
   <p>It expires in 1 hour. If you didn't ask for it, ignore this email.</p>
   ```

   Remove `{{ .ConfirmationURL }}` from both, so nobody signs in by tapping a link.
   Subjects like "Your Honey code" work well.
3. Codes are 6 digits and last 1 hour by default (**Email → Email OTP expiration**). An
   address can ask for a new code once every 60 seconds; the app's Resend timer matches.
4. **Before real users: set up custom SMTP.** Supabase's built-in email only delivers to
   your own team's addresses and about 2 emails an hour. Sign up for an email service
   (for example Resend, Postmark or Amazon SES), verify your sending domain, then fill in
   **Authentication → Emails → SMTP Settings**. Then raise **Authentication → Rate
   Limits → emails per hour** to fit your launch.

## 5. Apple (native Sign in with Apple, iOS)

App Store rule: an app that offers Google sign-in must also offer Sign in with Apple. On
iPhone Honey uses Apple's native sheet. Android shows Google and email only.

1. **Apple Developer → Certificates, IDs & Profiles → Identifiers.** Open the App ID for
   bundle ID `com.honeywallet.app` (create it if missing: **+ → App IDs → App**). Tick the
   **Sign In with Apple** capability and save. (EAS Build also turns this on when it
   manages signing, because the app ships the Sign in with Apple entitlement.)
2. **Supabase → Authentication → Sign In / Providers → Apple.** Turn it on. In
   **Client IDs** enter `com.honeywallet.app`. If you test in Expo Go add
   `host.exp.Exponent` too, and add any other bundle IDs your dev builds use (comma
   separated). Save. Leave the Services ID / secret key fields empty for now.
3. Hide My Email: people who hide their address get one like
   `abc@privaterelay.appleid.com`. Apple only forwards mail from senders you register. In
   Apple Developer go to **Services → Sign in with Apple for Email Communication →
   Configure → +** and add your SMTP sending domain or address from section 4.

The native iPhone flow does **not** need a Services ID or a `.p8` key, and so has no
6-month key rotation. Those are only for Apple sign-in in a browser (web or Android),
which Honey doesn't offer. If you add it later, follow Supabase's
[Apple guide](https://supabase.com/docs/guides/auth/social-login/auth-apple) and put the
Services ID first in **Client IDs**.

## 6. Google

1. In <https://console.cloud.google.com> pick or create a project.
2. **Google Auth Platform → Branding** (the OAuth consent screen): app name `Honey Wallet`,
   support email, logo, and links to `https://honeywallet.app/privacy` and `/terms`.
   Under **Data Access** keep `openid`, `.../auth/userinfo.email` and
   `.../auth/userinfo.profile` (add `openid` if it's missing). Nothing more.
3. **Google Auth Platform → Clients → Create client**, type **Web application**, name it
   `Honey Supabase`. Under **Authorized redirect URIs** paste the **Callback URL** shown
   on Supabase's Google provider page (it looks like
   `https://<project-ref>.supabase.co/auth/v1/callback`). Create it and copy the
   **Client ID** and **Client Secret**.
4. **Supabase → Authentication → Sign In / Providers → Google.** Turn it on, paste the
   Client ID and Client Secret, and save. Leave **Skip nonce checks** off.
5. Before launch, set the consent screen's publishing status to **In production** (Google
   limits "Testing" apps to 100 test users).

Honey opens Google in the system browser sheet, so no iOS/Android Google client IDs or
Google SDK are needed.

## 7. Allow the app's redirect

1. **Authentication → URL Configuration.**
2. Under **Redirect URLs** add `honeywallet://auth-callback`. For Expo Go during
   development you can also add `exp://**`. Save.
3. **Site URL** can stay your website (for example `https://honeywallet.app`). Supabase
   falls back to it when a redirect isn't allowed, which means the app's redirect is
   missing from the list above.

## 8. Make a new build

The app's native config changed (`@clerk/expo` removed, `ios.usesAppleSignIn` on). Expo Go
and older dev builds don't match, and an OTA update can't change native code. Build again:

```sh
cd apps/mobile
pnpm exec expo prebuild --clean   # only if you build locally; ios/ and android/ are generated
pnpm exec expo run:ios            # or: pnpm eas build --profile preview --platform ios
```

Then test on a real iPhone and an Android phone: **Create a new wallet** → Continue with
Apple (iPhone), Google and email; and **I already have a wallet** → sign in → "Signed in
as …" with the restore options.

## 9. Server

### Verify sign-ins (optional)

The API can check a Supabase access token and return the user id at
`GET /api/v1/me/identity` (send `Authorization: Bearer <session.access_token>`). It is off
until one variable is set in `apps/server/.env` (or your deployment's secrets):

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
```

The server derives the issuer (`<url>/auth/v1`) and the public keys
(`<url>/auth/v1/.well-known/jwks.json`), and accepts ES256 or RS256 tokens for
`aud: authenticated` from signed-in, non-anonymous users. Tokens signed with the legacy
HS256 secret are rejected, so finish section 3 first. No Supabase secret is needed.

### Use Supabase Postgres as the database

1. Select **Connect** at the top of the dashboard.
2. Pick the **Direct connection** if your server host has IPv6 (or you bought the IPv4
   add-on). Otherwise pick **Session pooler** (port **5432**). Don't use the
   **Transaction pooler** (port 6543): Honey keeps long-lived connections and needs
   session features (prepared statements, per-connection timeouts, the migration lock),
   so the server refuses that URL at startup.
3. Copy the URI, put in your database password, and add `?sslmode=require`:

   ```sh
   # Session pooler
   DATABASE_URL=postgres://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres?sslmode=require
   # Direct
   DATABASE_URL=postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
   ```

   Better: download the CA certificate (**Database settings → SSL Configuration**) and use
   `sslmode=verify-full&sslrootcert=/path/to/supabase-ca.crt`, so the server also checks it
   is talking to Supabase.
4. Keep `DATABASE_MAX_CONNECTIONS` (default 20 per server process) inside your plan's
   connection limit, counting every server process.
5. **Lock the database away from the app key first (important).** Honey's migrations
   create their tables in the `public` schema, and on Supabase every new `public` table
   is by default readable and writable through the Data API by anyone holding the anon /
   publishable key, which ships inside the app. Honey never uses the Data API, so:
   1. Dashboard → **Integrations → Data API** (also under Project Settings → Data API):
      turn **Enable Data API** off.
   2. **SQL Editor**, run once, before the first migration:

      ```sql
      alter default privileges for role postgres in schema public
        revoke all on tables from anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        revoke all on sequences from anon, authenticated, service_role;
      alter default privileges for role postgres in schema public
        revoke all on functions from anon, authenticated, service_role;
      alter default privileges for role postgres
        revoke execute on functions from public;
      revoke all on all tables in schema public from anon, authenticated, service_role;
      revoke all on all sequences in schema public from anon, authenticated, service_role;
      revoke all on all functions in schema public from anon, authenticated, service_role;
      ```

      If you ran a migration before this, run the last three lines again afterwards.
6. Run the migrations once: `honey-server migrate`. Keep the URL in your secret manager;
   it contains the database password.

## 10. Going live checklist

1. Pro plan, custom SMTP, and email templates showing `{{ .Token }}` (sections 1 and 4).
2. Asymmetric JWT keys rotated in (section 3); `SUPABASE_URL` set on the server.
3. Apple and Google providers on, Google consent screen **In production**.
4. `honeywallet://auth-callback` in Redirect URLs.
5. The two `EXPO_PUBLIC_SUPABASE_*` variables in the production EAS environment.
6. Data API off and the `revoke` SQL run (section 9), `DATABASE_URL` on port 5432 with
   `sslmode=require` or better.
7. App Store: apps that let people create an account must also let them delete it in the
   app. Plan an account-deletion path for Supabase accounts before submission (deleting
   a user needs the secret key, so it has to run on the server, never in the app).

## Browser extension

Honey for Chrome doesn't show Apple / Google / email yet. Native Sign in with Apple is
iPhone-only and an OAuth redirect would leave the popup. The extension keeps the recovery
phrase, import and pair-with-phone options, and the `EXPO_PUBLIC_SUPABASE_*` variables in
`apps/extension/.env.local` have no effect.
