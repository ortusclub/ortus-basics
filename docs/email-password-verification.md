# Email verification for Basics signup and password recovery

Status: implemented and locally tested; not released. Mail sending is not yet
configured. Existing deployed apps still use the previous recovery flow until
the gateway and a new desktop release have both been published.

The desktop requests a six-digit code from the shared gateway. Firestore stores
only its digest, email, purpose, expiry, attempts and consumption state. A code
expires after ten minutes, permits five guesses and works once. Signup and reset
have separate purposes. Requests have a 60-second recipient cooldown, a shared
five-per-recipient hourly quota and a 200-per-hour service quota. Quotas and
consumption are transactional across Cloud Run instances. No per-IP quota is
used: shared office networks and the Cloud Run proxy must not collapse all team
members into a single small limit.

The initiating browser holds an HttpOnly, same-site cookie; another browser
cannot finish its pending request. The old reset endpoint now only requests a
code. Neither clicking Forgot password nor requesting a code deletes or changes
a password. After verification the app saves the new password atomically and
invalidates previous sessions for that local account. Existing passwords and
sessions survive failed or unavailable email delivery. Local account stores are
still per installation; this does not introduce a centralized password database.
Google sign-in and public shared Sheets access are unchanged.

## Mail configuration needed before rollout

Select and authorize a sender mailbox or transactional mail provider. Configure
SMTP_HOST, SMTP_PORT (587 default; 465 supported), SMTP_USER, SMTP_PASS and
SMTP_FROM on the gateway. SMTP_USER and SMTP_PASS must be Secret Manager bindings,
never desktop environment files, source, release assets or pasted chat messages.
The configured provider must permit SMTP_FROM. TLS is required. Do not deploy
until a real code can be received and verified by the chosen test account.

Deploy the source in services/sheets-gateway to project ortusbot, region
asia-southeast1, service ortus-sheets-gateway. Preserve ALLOW_PUBLIC_SHEETS=true,
existing OAuth configuration and existing secret bindings using update flags.
Enable Firestore TTL on emailVerification.ttl in database ortus-sheets-gateway.
Verify that unauthenticated Sheets access and Google app login still work.

Before publishing the desktop update, verify a real signup and reset, wrong code,
expired/reused code, old-password rejection, and retained campaigns. Without mail
configuration the endpoint fails closed with a clear message suggesting Google
sign-in. Never restore the previous email-only password deletion fallback.

Local tests: tests/email-verification.test.js, tests/email-password-auth.test.js,
tests/password-reset-session.test.js plus existing Google and Sheets tests.
Browser smoke covered both forms, delivery failure, wrong-code errors and success
using mocked email delivery; this is not evidence of live email delivery.
