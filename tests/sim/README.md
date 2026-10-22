# Campaign simulator

Runs the **real** campaign engine (`startCampaign`, the acceptance sweep, the real LinkedIn action
code) against a fake outside world, and checks *outcomes*. Nothing touches LinkedIn, GoLogin or Google.
Built so it keeps working however the campaigns are changed: it judges what reached LinkedIn and what
ended up on the sheet, not how the code got there.

```
npm run test:sim                              # everything (~4 min here; ~8 min on a laptop; SIM_SPEED=1 for real-time waits)
SIM_ONLY='^connect_only/' npm run test:sim    # regex filter on "<mode>/<scenario>"
SIM_CONCURRENCY=2 npm run test:sim            # fewer parallel browsers
```

Output: `tests/sim/reports/latest.md` (bug notes) · `latest.json` (evidence) · `logs/*.log` (full engine
output per scenario). Exit code 1 only when there is a **new** finding.

## How it works
| Piece | File | What it fakes |
|---|---|---|
| Browser launcher | `fakes/gologin-launcher.mjs` | Swapped in by an ESM hook (`register.mjs`/`hooks.mjs`) for every import of `src/gologin-launcher.js`. Opens a real headless Chromium. |
| LinkedIn | `fakes/fake-linkedin.mjs` | Profile pages, invite dialog + Voyager invite endpoint, `/messaging/compose` (1:1 and typeahead/group), recent-connections endpoint, login wall, 404 redirect. The real selectors and click logic run against it. |
| Google Sheets + Apps Script | `world.mjs`, `gas.mjs` | CSV export and the web-app POSTs. Column provisioning and field→column mapping come from the **real** tables in `google-apps-script.js`, so the fake sheet changes when that file does. |

## Discovery (why new campaigns are picked up automatically)
`modes.mjs` reads `MODE_LIST` from `public/js/app.js`, drops `RETIRED_MODES`, and `discover.mjs` keeps
the ones the engine drives (`getModeHint(mode) != null`). Each gets the generic scenarios in
`scenarios.mjs`. A mode with no entry in `MODE_PROFILES` still runs with `DEFAULT_PROFILE` and is
flagged "GENERIC" in the report — the only thing to maintain is a profile (eligible rows, required
templates, expected sheet stamps) when a campaign needs special seed data.

## Invariants (`checks.mjs`)
Loop finishes · no crashes · no lead sent twice · every lead gets a status · what LinkedIn received ==
what the sheet says · daily limit respected · a broken account (throttled / logged out / won't launch)
doesn't stop a healthy one · ordinary leads are never left in a terminal "Skipped/Failed" state ·
mode columns land in the final sheet · no code/`undefined`/`NaN` in any written cell or audit-log date ·
acceptance sweep follows up with exactly the accepted leads, once, and records it.

## Start-up checks (before the engine runs)

Two extra scenarios per campaign type drive the REAL app, not just the campaign engine. Both boot the real `server.js`
(`startup/server.mjs`, with the fake sheet from `startup/preload.mjs`, a throwaway data folder and a signed-in cookie).

- **`setup-screen`** (`run-screen.mjs`): opens the real app screen in a headless browser and does what an operator does —
  "+ New campaign", click the campaign type's card, open the sheet section, paste a link, "Preview sheet" — then checks that
  every control the campaign type needs is visible (not just present) and that the screen throws no script errors. Controls are
  listed per campaign type in `modes.mjs` (`screenControls`); buttons and cards are found by their visible text. To see which
  controls are visible for a type, run with `SIM_SCREEN_EXTRA=id1,id2` (extra ids are probed and listed in the scenario log).
- **`start-gates`** (`run-gates.mjs`): sends the requests the screen sends when Start is pressed, with generated good and bad
  setups. A good setup must be accepted; one that cannot run (no sheet link, daily limit 0, empty sheet, no URLs, no accounts, bad
  primary link, no tab chosen) must be refused with a readable reason; the sender-column check must flag a blank column.

Not covered: checks that exist only in the screen's own code before it calls the server (for example required message
boxes and pop-up confirmations) — the screen check only proves those fields are present and visible.

## Known findings
`known-findings.json` lists acknowledged bugs (`"<mode>/<scenario>:<check>"`, `*` wildcards allowed).
They stay in the report as 🟡 KNOWN but don't fail the run. Remove an entry once the bug is fixed.

## Not covered yet
Check DMs, Follower Growth, Post Amplification, Mature Profile (not driven by `startCampaign`), and the
Automated Dialer / SMS / WhatsApp campaigns. Throttle (HTTP 429) is simulated on the invite endpoint only.
