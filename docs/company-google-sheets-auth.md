# Company Google sign-in for Sheets

Status: Google Desktop client configured and gateway revision
`ortus-sheets-gateway-00002-k7r` deployed on 2026-09-28. Basics 1.7.57
was promoted to production; 1.7.58 adds compact connection settings.
Live configuration, unsigned/forged rejection and legacy spreadsheet reads passed.
A real company-account sign-in also successfully authorized a campaign spreadsheet
read through the Google bearer-token path. A write using that connection has not
yet been separately verified.

## User experience

In Basics, open workspace Settings and select **Connect Google Sheets**. Sign in
in the system browser using a managed Google Workspace account at ortusclub.com,
ortus.solutions, linkedvelocity.com or apexstrategy.io. The gateway verifies the
Google signature, audience, issuer, expiry, verified email and matching hosted
domain. GoLogin tokens do not authorize this connection.

Signing in automatically retries locally saved campaign results. Retries continue
while Basics is open and resume after a restart. They only write saved results;
they do not resend LinkedIn messages. Results already lost by an older release
cannot be reconstructed by this queue.

The writer can update any spreadsheet it has editor access to. Company sign-in
does not grant the writer access to arbitrary private spreadsheets or protected
ranges. Share new spreadsheets with the existing Apps Script deployment owner
(sam@ortusclub.com for the independent bridge), or a group including that owner.
No per-user Apps Script installation is required. This authorizes all approved
company users to use the shared writer across its accessible sheets; it does not
mirror each user's individual Drive sharing permissions.

## One-time administrator setup

1. In Google Cloud project `ortusbot`, configure Google Auth Platform branding
   and audience. Multiple independent Workspace organizations require **External**
   audience. Use production publishing status for a team rollout; testing mode
   restricts access to configured test users. Only `openid email` is requested.
2. Create an OAuth client with application type **Desktop app**. Download its
   JSON to a local file. Do not use a Web application client or paste credentials
   into chat. The desktop flow uses a random loopback callback port and PKCE.
3. Reauthenticate the administrator's gcloud session if expired (`gcloud auth login`).
4. From the repository, run:

   ```sh
   node scripts/deploy-google-sheets-auth.mjs /absolute/path/to/client.json
   ```

   This updates the existing gateway service using its current bridge secret and
   legacy workspace-key bindings. It does not change spreadsheet sharing.
5. Verify `/auth/config` is available, sign in with a permitted account in a dev
   app, reject an unapproved account, and test one disposable spreadsheet write
   and readback. Also test an inaccessible sheet and confirm its result remains
   pending with an error. Restart Basics and verify pending writes recover.
6. Build and distribute the next Basics release using the existing isolated,
   credential-free release procedure. Do not package the developer `.env`.

The OAuth desktop client metadata is served publicly by `/auth/config`; native
installed apps cannot keep client secrets confidential. The private Apps Script
URL/key and legacy HMAC keys remain server-side. ID/refresh tokens are stored in
a mode-0600 local data file and never returned to the renderer or written to logs.
Google verifies users on every gateway request; typed app operator labels are not
used as identity. Disconnect removes local tokens. Users can also revoke Basics
from their Google account's connected apps.

## Migration and rollback

The service temporarily accepts existing HMAC requests for older apps. Updated
apps use Google when connected and never fall back to GoLogin following a Google
rejection or an explicit disconnect. An installation that has never connected
Google can continue using its previously approved legacy workspace token during
rollout. Remove legacy keys only after all clients migrate. A failed request with
a Bearer header cannot downgrade to HMAC authentication.

Retain the prior Cloud Run revision for rollback. Do not switch writer URLs to
work around authorization failures. Separate cloud campaign engines and other
products need their own migration; this change is for local Ortus Basics.

References: https://developers.google.com/identity/protocols/oauth2/native-app
and https://developers.google.com/identity/gsi/web/guides/verify-google-id-token.
