# Ortus team Sheets gateway

Project: `ortusbot` (display name Ortus Basics); region: `asia-southeast1`.
Service: `ortus-sheets-gateway`. Desktop endpoint: `/bridge`; public health: `/health`.

The download contains no reusable gateway/bridge credential. Requests are signed
using a purpose-specific HMAC key derived locally from an approved GoLogin
workspace token already stored in app Settings. The server stores only the
derived keys, plus the separate Apps Script URL/key, in Secret Manager.
Possession of a downloaded installer, an email address or an app cookie grants
no gateway access. Possession of an approved workspace credential grants team
bridge access; it is not per-user or per-spreadsheet authorization.

The signed envelope covers protocol, method, path, timestamp, random nonce and
body digest. Maximum clock skew is two minutes. Firestore's create-only nonce
records reject replay across instances; unavailable storage fails closed.
TTL deletes expired records. Only an explicit action allowlist is forwarded;
selfTestBridge is not exposed. Upstream URLs/errors/stacks are not returned.

Runtime identity: `ortus-sheets-gateway@ortusbot.iam.gserviceaccount.com`.
Secrets: `ortus-sheets-bridge-url`, `ortus-sheets-workspace-keys`. Values never
belong in this directory, build arguments, screenshots, logs or desktop bundles.
Database: named Firestore database `ortus-sheets-gateway`, collection
`gatewayNonces`, TTL field `expiresAt`.

Cloud Run permits public transport because desktops use application-level
signatures, not Google IAM tokens. Requests without valid signatures receive
401 before contacting the bridge. It scales from zero to at most two configured
instances, with 256 MiB / one CPU and 20 concurrent requests per instance.
These limits are not a monetary spending cap; usage and storage incur charges.

The initial approved workspace set is the team credential available in Sam's
installed app. New/rotated workspaces need administrator enrollment of their
derived key in Secret Manager and a new pinned secret version deployment.
Never distribute these server-side derived keys with the app. Existing users
with an approved workspace only update/restart; no new login is required.

The old cloud engine cannot sign these requests. The app deliberately continues
to pass its previous Sheets URL to that engine until engine support is deployed.
This release targets local Mac campaign writes and does not claim cloud parity.
Separate FG, Magellan and log bridges are not changed.

Before each release: run gateway authentication/transport tests, then verify
health, unsigned rejection, signed sheet write/readback and replay rejection
against a disposable sheet. Verify both packaged architectures have no key and
select the live gateway. Publish only after all required checks pass.

Deploy from this folder with the service-specific gcloud source build, runtime
identity and versioned Secret Manager bindings. Keep the prior Cloud Run
revision for rollback. Rolling back to desktop 1.7.54 restores its old bridge;
do not silently retry failed writes against a different bridge.
