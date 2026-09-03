# Ortus Basics

LinkedIn outreach, pared back: three campaign types (Message, Connect + Introduce
Back, Introduction), running entirely on your own Mac.

## Install

Paste this into Terminal. It picks the right build for your Mac, installs to
`/Applications`, and opens the app:

```bash
curl -fsSL https://raw.githubusercontent.com/ortusclub/ortus-basics/main/install-basics.sh | bash
```

Or download the DMG directly from [Releases](../../releases/latest) —
`Ortus-Basics-arm64.dmg` for Apple Silicon, `Ortus-Basics-x64.dmg` for Intel.

## First run

**The app ships with no credentials and does nothing until you add one.** On
first launch it opens **Settings** and asks for a GoLogin API token.

What you can use follows from what you paste. Each workspace is listed
separately — Ortus, Linked Velocity, Marketing, plus any others you add
yourself. A workspace with no token contributes no accounts and never appears
in the picker. Tokens are stored only on your own Mac, under
`~/Library/Application Support/Ortus Basics`, and never leave it.

## Notes

- macOS only, Apple Silicon and Intel.
- The build is unsigned. The installer strips the quarantine flag for you; if
  you install the DMG by hand instead, right-click the app and choose **Open**
  the first time.
- Campaigns run while the app is open. There is no cloud mode.
- Acceptance checks are manual — nothing runs on a timer.
