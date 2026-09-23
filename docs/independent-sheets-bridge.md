# Independent Sheets bridge

This checkout can use a separately owned Google Apps Script deployment for
campaign sheet writes, Recent Connections, tracking columns, sheet tabs, and
the other actions served by `google-apps-script.js`. The canonical script is
reused so matching, sender scoping, timestamps, and column aliases stay intact.
Separate FG, Magellan, and operations/campaign log deployments are not migrated.

Owner for this installation: **sam@ortusclub.com**.

Deployed on 2026-09-23: [Sam's project](https://script.google.com/home/projects/1jo7CKuLoN4IpBtMBjp4XJvpck3X0BDNmy0xlkrtelV7RyWjM614f-foe/edit).
Deployment ID: `AKfycbzPLa8j57j-dsq__1j5uKS21pLQAKNy2lCoGmGUHEM60S3fOaqvwppip6hXFexqDF0jrg`.
Version 2 passed disposable-sheet writes/readback and campaign-tab reads.
The development checkout's `.env` selects this deployment; Electron was restarted.

## Deploy

1. Sign in using `clasp -u ortus-basics-sam login`, selecting the owner account.
2. Create a new standalone project in the private, ignored deployment directory:

   ```sh
   mkdir -p apps-script/independent
   cd apps-script/independent
   clasp -u ortus-basics-sam create --type standalone --title 'Ortus Basics — Sam Sheets Bridge'
   cd ../..
   node scripts/prepare-independent-sheets.mjs
   clasp -u ortus-basics-sam -P apps-script/independent push
   ```

3. Open the new project with `clasp -u ortus-basics-sam -P apps-script/independent open-script`.
   Run `authorizeBridge` once in the editor and grant the requested Google access.
   The owner must have edit access to the campaign spreadsheets.
4. Deploy using `clasp -u ortus-basics-sam -P apps-script/independent deploy --description 'Independent Sheets bridge'`.
5. Verify and activate with:

   ```sh
   node scripts/activate-independent-sheets.mjs <deployment-exec-url> <campaign-sheet-id>
   ```

   Activation checks the replacement's identity, reads the selected sheet's
   tabs, and verifies writes/readback on a temporary private sheet (trashed
   afterwards) before changing `.env`. It backs up `.env` once, then sets
   `ORTUS_SHEETS_WEBAPP_URL` for this checkout. Restart Electron when no campaign
   or connection check is running. A page reload alone does not reload backend
   environment variables.

The deployment accepts unauthenticated HTTP transport so Electron can call it,
but its entry points require a random 256-bit private key. The generated script,
key, project ID, and `.env` remain local and ignored by Git. Do not share the
key-bearing endpoint or package this local `.env` into a public release.

## Verification

Use a disposable spreadsheet to verify accepted and timestamped pending row
updates plus Recent Connections creation/readback before a live sweep. Do not
replay historical sweep results as though they were a new LinkedIn check.

The app now treats HTTP access errors and unconfirmed batch writes as failures.
It also warns if the Recent Connections tab could not be confirmed saved.

## Rollback

Remove `ORTUS_SHEETS_WEBAPP_URL` from the local `.env` and restart Electron to
return to the legacy endpoint. That endpoint was returning HTTP 403 during this
investigation, so rollback does not itself restore working sheet writes.
