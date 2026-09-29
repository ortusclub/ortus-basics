# Shared GoLogin fallback

Ortus and Marketing token fields use the shared gateway only when no local or
environment token is set. A supplied but invalid token is never silently
replaced. Linked Velocity and custom workspaces retain their existing behavior.

The gateway endpoint GET /gologin/shared requires a verified company Google
identity even though Sheets access is public. It uses the existing approved
Google Workspace domain list. Email/password login alone does not authorize
shared credentials; connect a company Google account in Account connections.

GoLogin's desktop SDK requires the API token to launch local browsers. Retrieved
tokens therefore exist in the app's background-process memory for five minutes,
then are fetched again when needed. They are not copied into environment
variables, settings files, renderer responses or installers. Authorized desktop
users can potentially inspect process memory; this is credential sharing among
trusted company users, not a guarantee that recipients cannot recover a token.
Disconnecting Google prevents new shared launches; it does not revoke a token
already used by an active GoLogin SDK session.

Local tokens take priority. Removing a local Ortus or Marketing token restores
shared fallback. Settings labels shared access and prompts for company Google
sign-in or reports unavailable server configuration. Profile-list and launcher
paths resolve through the same source. Marketing profiles remain restricted to
introduce_back (Introduction Campaign); existing operator/workspace rules apply.

Cloud setup: bind approved Secret Manager versions to SHARED_GOLOGIN_ORTUS and
SHARED_GOLOGIN_MARKETING on ortus-sheets-gateway in project ortusbot, region
asia-southeast1. Do not copy credentials into source or release environments.
Keep existing email, Google and public Sheets configuration intact. Missing
secrets contribute no shared workspace; the endpoint never falls back to public
access. Explicit authorization is required before exporting a saved local token
for shared team use.

Validation: tests/shared-gologin.test.js covers manual precedence, in-memory
expiry, disconnect/account switches, failure backoff and authentication despite
public Sheets mode. Existing GoLogin tests cover profile ownership and Marketing
mode restrictions. Real-token deployment remains dependent on approved tokens.
