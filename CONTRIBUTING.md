# Contributing to The Ortus Outreach

LinkedIn outreach automation for The Ortus Club. macOS Electron app.

## Where the code lives

All source is on the **`source`** branch. The `main` branch only has the installer README + `install-mac.sh`.

**Rule:** always branch off `source`, never commit directly to it. Every change goes through a PR.

## Local setup (10 min, one-time)

**Prerequisites:** macOS, Node.js v20 or newer (`node --version` to check; install via [nodejs.org](https://nodejs.org) or `brew install node` if missing).

```bash
# 1. Clone and check out the source branch
git clone https://github.com/ortusclub/ortus-outreach-installer.git
cd ortus-outreach-installer
git checkout source

# 2. Install dependencies
npm install

# 3. Copy .env.example → .env (already populated with the company GoLogin token)
cp .env.example .env
```

### Environment variables

`.env.example` already has the company-wide `GOLOGIN_API_TOKEN` baked in, so a plain `cp .env.example .env` is enough to start working. Other vars in the file have sensible defaults for development.

If you want to point the dashboard at a different Apps Script deployment (e.g. to test against your own sheet instead of production), edit `SHEETS_WEBAPP_URL` in `.env`.

### Verify it works

```bash
npm test          # should print "111/111 pass"
npm run dev:app   # launches the Electron dashboard
```

The Electron window opens with the dashboard. If you see it, you're set.

## Development workflow

Two-person team, simple PR-based flow.

### Making a change

```bash
# Always start fresh from source
git checkout source
git pull origin source

# Branch off — naming pattern: <your-name>/<short-description>
git checkout -b sam/fix-stage-typo

# Make your edits. Test as you go.
npm test

# Commit (mirror the existing commit style — see git log for examples)
git add <files>
git commit -m "Short imperative subject"

# Push and open a PR
git push -u origin sam/fix-stage-typo
gh pr create --base source --title "Short subject"
```

### Reviewing each other's work

The other person reviews on github.com — line comments, questions, suggestions. Either:

- **Approves** → you click "Squash and merge"
- **Requests changes** → push more commits to the same branch; the PR auto-updates

### Commit message style

Look at existing commits (`git log --oneline -20`) and match the pattern:

- Release commits: `vX.Y.Z: <short subject>` followed by a body explaining the *why*
- Feature/fix commits: `<verb> <thing>: <short subject>` — e.g. `Add: Voyager network listener`, `Fix: stale references in worker pool`

Body explains **why**, not **what** (the diff shows what). Reference the bug/feature reasoning so future-you can re-read and understand the motivation.

### Shipping a macOS release

When you and Antonio have agreed to release, merge the changes and bump both
`package.json` and `package-lock.json` on `main`. Use
`npm version <version> --no-git-tag-version` in the version bump branch.

In GitHub, open **Actions → Release macOS → Run workflow** and select `main`.
Leave **Publish both DMGs to GitHub Releases** checked to publish, or clear it to
build and download the DMGs from the workflow run's **Artifacts** section.

Publishing uses the version in `package.json`. Both builds must succeed before
the workflow publishes `Ortus-Basics-arm64.dmg` and `Ortus-Basics-x64.dmg` to the
matching tag. Use a new version for each release. The app picks up the published
version through **Check for updates**.

## Project structure

```
src/
  campaign.js              Main campaign loop, worker pool, state management
  browser-semaphore.js     Hard cap of 2 browsers simultaneously open
  gologin-launcher.js      GoLogin Orbita browser launches
  local-launcher.js        Local Chromium for the "You" account
  sheets-writer.js         Google Sheets API client
  linkedin/
    actions.js             Connect, message, send, verify
    outreach.js            Per-lead orchestration; URL transforms
    helpers.js             Voyager API, click helpers
    check-dms.js           Message-thread scraping
public/
  index.html               Dashboard UI
  js/app.js                Frontend logic
  css/                     Styles
electron/
  main.js                  Electron main process, tray, window
server.js                  Express API the dashboard hits
tests/                     node:test suite, runs in ~2s
```

## Gotchas to know about

- **Two browser launchers**: GoLogin Orbita (for normal LinkedIn accounts) and local Chromium (for the "You" / Antonio account). A hard semaphore caps the total at 2 — see `src/browser-semaphore.js`. Don't bypass it.
- **6-min per-account turn floor**: every LinkedIn account waits at least 6 min between batches of 5 leads. This is the eject-cascade safety net (when most profiles drop out mid-run, the survivors would otherwise hammer LinkedIn at unsafe rates). Don't remove it. Context: commit `82040e7` (v2.11.0).
- **Sheet schema changes** require redeploying the Apps Script bridge at `~/Desktop/ortus-outreach-sheets-bridge.gs`. Antonio's machine has the canonical copy.
- **`.env` is gitignored**: never paste real secrets into committed code. If you accidentally commit one, rotate it and force-push.
- **No `console.log` in production paths**: the campaign log goes to `data/campaign.log` and is what the operator reads. Keep new logging consistent with existing `[module] message` format.

## Questions

Ask Antonio (info@ortus.solutions) directly, or open a draft PR with `[WIP]` in the title and discuss inline. Both work.

Sam onboarded 2026-05-07

