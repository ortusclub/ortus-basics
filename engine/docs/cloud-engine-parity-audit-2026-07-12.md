# Cloud Engine ↔ Local App Parity Audit + Fix Plan (2026-07-12)

**Goal:** the VM (this engine, `ortus-salesnav-scraper-cloud`) must behave IDENTICALLY to the
local app (`ortus-gologin-clone`, the SOURCE OF TRUTH) — every fallback, dedup, detection,
personalization, write-back. Divergence IS the bug class. See memory
`feedback_vm_must_mirror_local_exactly`.

**Discipline (Antonio's rule):** when fixing, DO NOT GUESS. Read the app's real implementation
first (`/Users/antoniovarlese/ortus-gologin-clone/src/linkedin/*`, `src/campaign.js`,
`src/sheets-writer.js`, `google-apps-script.js`) and mirror it. Verify behavior, don't assume.

**Why the fork exists:** `actions.js`, `helpers.js`, bulk-check core, `intro-constants.js`,
`profile-identity.js`, `match-primary.js` are copied BYTE-IDENTICAL. The drift is entirely in the
ORCHESTRATION WRAPPERS the engine re-wrote (`campaign-autointro.js`, `campaign-autodm.js`,
`campaign-monitor.js`, `campaign-runtime.js`, `campaign-sheet-writer.js`) because the app versions
are coupled to single-process Electron state (`campaign._abort`, in-memory sets, `_browserAlive`,
sheet-as-source-of-truth). Ideal end state: make the app's `auto-intro.js`/`auto-dm.js` importable
and share them instead of re-implementing.

---

## FOUR ROOT CAUSES (fix these, not 28 symptoms)

- **R1 — `leads.row_data` is never merged into the working row.** `leadToRow`
  (`campaign-monitor.js:26-38`) and the two personalization data maps
  (`campaign-autointro.js:personalizationData`, `campaign-autodm.js:dmData`) build a minimal
  fixed row and never spread `row_data`. Breaks: blank `{company}`/`{title}`/custom tokens, dead
  numeric-ID matching, weaker dedup. **Reference that does it right:** `campaign-action.js:29-45`
  spreads `...row`.
- **R2 — the auto-intro / auto-DM WRAPPER was rewritten, not vendored.** `campaign-autointro.js`
  reimplements `src/linkedin/auto-intro.js` and dropped the resilience. Breaks: retry loop, photo
  disambiguation, INTRO_ALREADY_EXISTS happy-path, interruption→Skipped, reverify-downgrade, full
  failure-string map, follow-up threadUrl capture. **Fix direction:** vendor/port
  `src/linkedin/auto-intro.js` + `src/linkedin/auto-dm.js` faithfully (like `actions.js` is).
- **R3 — bulk-check is partitioned by single account.** `runBulkCheck` feeds
  `store.getConnections(campaign.id, account)` + `assigned_profile === account`
  (`campaign-monitor.js:75-79`, `campaign-store.js:411-419`). Kills cross-account acceptance
  detection + cross-account dedup (the whole-sheet pre-pass). Architectural — fights the per-account
  lock model; needs a whole-campaign lead+connection set fed to `computeBulkCheckUpdates`.
- **R4 — whole subsystems never ported.** Reply/check-DMs detection (no inbox-sweep/check-dms
  modules vendored at all), `ensureColumns` provisioning (never called), and half of `buildTracking`
  write-back columns.

---

## ALL DIVERGENCES (ranked; VM does LESS/DIFFERENT than local)

### CRITICAL
1. **Reply detection absent on VM** (R4). Local: `src/campaign.js:5327-5337` `_REPLY_MODES` →
   `registerReplyTracking`; `src/linkedin/{inbox-sweep,check-dms}.js`, `src/reply-classify.js`,
   `src/replies-log.js`. VM: no reply/inbox modules exist; scheduler only handles
   monitor/follow_up/accept (`campaign-runtime.js:272-275`). Hits CC+IC, CC+DM, message_only, ICB.
2. **CC+DM sends `{company}`/`{title}` blank** (R1). Local `src/linkedin/auto-dm.js:230-231` reads
   `row['Company']`/`row['Title']`. VM `campaign-autodm.js:37` reads blank `lead.company`/`lead.title`.
3. **Custom sheet-column tokens dropped** (R1). Local `auto-dm.js:225` + `auto-intro.js:617` start with
   `...row`. VM `campaign-autodm.js:32-39` + `campaign-autointro.js:100-110` don't spread `row_data`.
4. **No `ensureColumns` provisioning** (R4). Local calls `prepareSheet`/`ensureTrackingColumns`
   (`src/campaign.js:2301-2306`; `google-apps-script.js:598-833`). VM: zero calls; Apps Script skips
   missing columns (`google-apps-script.js` `if (colIndex === -1) continue;`). Missing column → stamp
   silently dropped (e.g. absent "Introduction Status").

### HIGH
5. **`INTRO_ALREADY_EXISTS` stamped "Failed"** (R2). Local `auto-intro.js:739-742,798-808` →
   "Introduction Already Made", counts sent. VM `campaign-autointro.js:54-56,69-81,183-186` → default
   "Failed —", failed++, no markActionSent.
6. **No same-name photo disambiguation** (R2). Local `auto-intro.js:168 _captureProfileAvatarToken`,
   `:713-759` retries with leadAvatarToken/primaryAvatarToken. VM `_vendoredSend`
   (`campaign-autointro.js:45-58`) passes `{dedupeProbe:true}` only, no tokens, no retry → ambiguous
   leads throw IC_INTRO_AMBIGUOUS_RECIPIENT → terminal Fail/skip.
7. **No retry loop** (R2). Local 2-attempt while-loop, INTRO_RECIPIENT_NOT_FOUND retry-once
   (`auto-intro.js:718-767`). VM single attempt (`campaign-autointro.js:166-190`).
8. **Follow-up queued with empty `threadUrl`** (R2). Local captures `page.url()`
   (`auto-intro.js:830-841`). VM hardcodes `threadUrl:""` (`campaign-autointro.js:53`) →
   `handleFollowUp`→`sendInThread(page,"",…)` can't post (`campaign-runtime.js:252-258`).
9. **Session death ≠ "Skipped"** (R2). Local checks `_abort`/`_browserAlive()` → "Skipped — …"
   (`auto-intro.js:549-597,792-793`). VM none → mid-send pod death → terminal "Failed" cascades.
10. **Intro branch keys on blank name column** (R1). VM branches on `data["full name"]` from
    `lead.full_name || first_name+last_name` — NO `row_data` fallback for full name
    (`campaign-autointro.js:85`) → when columns blank, drops to URL-routed sendIntroMessage, which can
    collapse to a 1:1 and drop the primary pill (v2.110 regression).
11. **Cross-account acceptance detection dead** (R3). Single-account connection set → `_matchedAccounts`
    only ever the sweeping account → cross-sender branch unreachable
    (`campaign-bulkcheck-core.mjs:427-459` dead; `campaign-monitor.js:75-79`).
12. **URN-only acceptances dropped** (R3). `upsertConnections` skips connections without publicId
    (`campaign-store.js:391-392`, PK `(campaign_id,account,public_id)`). Local keeps urn/memberNumber
    (`bulk-check-connections.js:689-697`).
13. **No reverify-and-downgrade** (R2). Local `_reverifyAndDowngrade` (`auto-intro.js:271-303,771-787`)
    + composeAttempts cap. VM none → false "Connected" never healed, no attempt cap.
14. **Write-back omits columns** (R4). Local sends `sender`/`accountUsed`/`linkedinUrn`/
    `linkedinMemberId`/`connectedAlready`/`op`/`message`/`inmail` hyperlinks (`src/campaign.js:1556,
    1602-1634,4087-4098`). VM `buildTracking` (`campaign-sheet-writer.js:29-49`) sends none → Account
    Used/Sender/URN/Membership/Connected columns blank; empty Sender breaks Check-DMs candidate filter.

### MEDIUM
15. **Whole-campaign dedup scoped to one account** (R3). Cross-account duplicate rows re-actioned.
16. **Numeric Member-ID identity axis (`num:`) dead** (R1). `leadToRow` never maps a `Member ID` column
    nor spreads `row_data` → `readSourceMemberId` always '' (`campaign-monitor.js:26-38`).
17. **No cross-campaign DM content dedup** (R2/R4). Local `hasDmBeenSent(publicId,body)` from
    `dm-sent-log.js` (`auto-dm.js:24,264-275`). VM per-campaign `wasActionSent` only; no dm-sent-log.
18. **Follow-up posts from WRONG identity**. Local posts as primary via `sender` routing
    (`auto-intro.js:211`, `primary-tasks.js:86-97`). VM `handleFollowUp` opens `payload.profileId`,
    ignores `payload.sender` (`campaign-runtime.js:252-258`) — note `handleAccept:265` honors sender.
    Fix: route by `payload.sender || payload.profileId`.
19. **Zero audit-log entries**. Apps Script writes Audit Log only when `accountUsed` present
    (`google-apps-script.js:1499`); VM never sends it.
20. **`{sender name}` blank; `_friendlyIntroFailure` truncated**. VM data maps lack `"sender name"`
    (`campaign-autointro.js`/`campaign-autodm.js`; `campaign-action.js:43` has it). VM friendly-map has 6
    patterns vs app's ~13 (`campaign-autointro.js:69-81` vs `auto-intro.js:313-364`).
21. **`connect_only` open-profile messaging not wired**. Local `_wantsOp = connect_only &&
    messageOpenProfiles` (`src/campaign.js:5200-5201`). VM `CONNECT_SPEC` never sets opChannel/
    openProfileBody (`campaign-action.js:48-62`).

### LOW
22. `{intro last name}` blank (`campaign-autointro.js:108` lacks it).
23. `_dedupeIntroUrls` work-list collapse absent (`auto-intro.js:59-71,521-526`) — redundant in
    current flow (queuedIdentityKeys covers a single sweep).
24. Duplicate-guard keyed on raw `lead_url` only, not strong identity.
25. `check_status` per-lead badge (`campaign-action.js:121-128`) vs app bulk Voyager
    (`src/campaign.js:2826-2865`) — slower, functionally equal.

### Positive / by-design (NOT regressions)
- Engine write-retry more cold-start tolerant (4×/1.5s/30s vs 3×/1s/15s) — `campaign-sheet-writer.js:67`.
- Parallel campaigns + multi-pod atomic lead claiming — cloud-only by design (local is 1-at-a-time).

---

## FIX PLAN (priority = root order; brainstorm/spec each before building)

1. **R1 — ✅ DONE + LIVE as v44 (2026-07-12).** Extracted ONE shared token builder
   `campaign-personalization.js` (`leadTokenData` = app auto-dm/auto-intro:616-633 base;
   `introTokenData` = + primary/intro keys, auto-intro:634-692). Spreads `row_data` first so every
   sheet column ({company}/{title}/custom {Event}) resolves; canonical keys as fallbacks; the
   SHEET column wins over the (usually blank) structured field (app-faithful — the app only reads
   the sheet row). `campaign-autointro.js` `personalizationData` + `campaign-autodm.js` `dmData`
   now delegate to it. `leadToRow` (`campaign-monitor.js`) passes through the source Member-ID
   columns (enables `readSourceMemberId`→`num:` axis, #16) while keeping every STATUS column
   DB-authoritative (a stale import-snapshot status must never shadow the DB verdict — so we do
   NOT spread all of row_data into the matcher row). Killed #2,#3,#10,#16,#20,#22. Pure tests:
   `test-r1-token-parity.js` (renders through the real vendored `personalizeTemplate`),
   `test-personalization-data.js` (updated to app-faithful precedence). NOT yet deployed.
2. **R2 (biggest):** vendor/port `src/linkedin/auto-intro.js` + `auto-dm.js` faithfully (retry loop,
   photo disambiguation, ALREADY_EXISTS, interruption→Skipped, reverify, threadUrl capture, full
   friendly-map, dm-sent-log). Kills #5-#9,#13,#17. Consider extracting a shared module both repos import.

   **R2 STAGING (state-mapping decisions — the engine has no Electron `campaign.*` state, so each
   app coupling maps to an engine equivalent; recorded so we don't guess):**
   - **Increment 1 — intro send-loop port (retry / ALREADY_EXISTS / photo-disambig / threadUrl / full
     friendly-map).** Kills #5,#6,#7,#8 (data),#20. Mirrors app auto-intro.js:699-841.
     · `campaign._primaryAvatarToken` cache → a per-sweep local `let primaryAvatarToken` in
       runAutoIntros (one primary per campaign; a sweep processes one account's accepted leads).
     · `_captureProfileAvatarToken` → ported verbatim into the engine (self-contained page.goto+
       evaluate) and made INJECTABLE (`captureAvatar` dep) so the retry logic is unit-testable.
     · threadUrl → `page.url()` captured in `_vendoredSend` after a successful send (was hardcoded
       ""), passed into the follow-up task payload. (Who POSTS the follow-up — #18 — is the separate
       cloud-primary-handshake question; NOT touched here.)
     · `_vendoredSend` now accepts `{leadAvatarToken, primaryAvatarToken}` and returns `{success,
       threadUrl, error}` so the loop can inspect the error string and retry with photos.
   - **Increment 1 — ✅ DONE (commit 175e454). Killed #5,#6,#7,#8(data),#20.**
   - **Increment 2 — ✅ DONE. Killed #9,#13.** Ported `_browserAlive(page)` (= app browser().connected
     + !isClosed()), a guarded `_stampSkipped`, the pre-send checkpoint + post-fail interruption
     reclassification (mid-send browser death → "Skipped — browser closed" + remainder Skipped + break,
     not a bogus Failed cascade), and reverify-and-downgrade (`_decideReverifyAction` pure verbatim +
     reverify via vendored getConnectionStatus; downgrade writes `connection_accepted_status` =
     "Unverified — manual review (…)" via updateLeadOutcome, DB not sheet). `getConnStatus`/
     `captureAvatar` injectable. Attempt cap SKIPPED — redundant on the engine (a failed intro stamps a
     non-blank introduction_status → isIntroSlotOpen false → not re-queued; markActionSent is durable).
     Full retry+interruption+reverify unit-tested in test-r2-intro-retry.js. NOT yet deployed (v45).
   - ~~**Increment 2 — reverify-downgrade + interruption→Skipped + attempt cap.** Kills #9,#13.~~
     · `campaign._abort` / `_browserAlive()` → engine: `page.isClosed?.()` for browser-dead; graceful
       stop already handled by the monitor tail re-reading campaign status. Interruption → stamp
       "Skipped — …" instead of "Failed —".
     · `_reverifyAndDowngrade` → port `_decideReverifyAction` (pure) + reverify via vendored
       getConnectionStatus; DOWNGRADE writes via `store.updateLeadOutcome` (DB), not updateSheetRow.
     · `campaign.composeAttempts` per-URL cap → a per-lead attempt counter (store method or a
       `compose_attempts` column); stop re-queueing after 3.
   - **Deferred to R4 / cloud-handshake:** dm-sent-log cross-campaign dedup (#17), follow-up identity
     (#18). Not simple ports — #17 is a new persistence subsystem, #18 depends on the primary running
     in GoLogin vs local-browser (Path B, dormant).
3. **R4:** port reply/check-DMs subsystem + add a `reply_check` scheduler task; call `ensureColumns`
   at campaign start; complete `buildTracking`; fix follow-up identity (#18). Kills #1,#4,#14,#19,#18.
4. **R3 (architectural, last):** feed whole-campaign lead+connection set to bulk-check. Kills #11,#12,#15.

**Test discipline:** each fix gets a pure unit test where possible (no PG/Redis); the engine repo uses
`node <file>.js` standalone tests (see `test-vendored-send.js`, `test-personalization-data.js`).
Integration (browser/PG/Redis) is UNTESTABLE locally — first real run is prod; flag before deploy.
Deploy = `gcloud builds submit --config cloudbuild.yaml --substitutions=_TAG=vNN --project=salesnav-scraper-prod .`
then bump `k8s/03-deployment.yaml` + `k8s/21-campaign-worker.yaml` + `kubectl apply`. Current live: **v48** (R3 — ALL ROOTS DONE).

## R4 — SHIPPED as v47 (2026-07-13)
- **#14 write-back columns + #19 audit log** (`campaign-sheet-writer.js` buildTracking): Sender/Account
  Used from `cfg.accountEmails[assigned_profile]`, linkedinUrn/linkedinMemberId, connectedAlready 'Yes',
  derived auditAction → audit log fires. Test: `test-r4-writeback-columns.js`.
- **#4 ensureColumns** (`prepareSheet` at queued→running via `provisionSheet`). Test: `test-r4-prepare-sheet.js`.
- **#1 reply detection** (`campaign-reply-check.js` = vendored checkProfileDms mirror + `reply` scheduler
  task with reap discipline + campaign_replies/campaign_reply_state tables + appendReply). Test:
  `test-r4-reply-check.js` (51). Commits: ced9d34 (#14/#19), 75d50ba (#4), 50530f8 (#1).
- **KNOWN GAPS (flagged, not blocking):** 'Recent Messages' sidecar dump not ported; persistent-transient
  pushRow failure doesn't retry the Reply/Stage stamp (appendReply lands + pushRow has internal retry);
  reply sweep adds a 2nd browser-open cycle per interval on monitored modes (reaped, but more churn).
- **REMAINING: R3** (bulk-check partitioned single-account #11/#12/#15 — architectural) + deferred #17
  (dm-sent-log) / #18 (follow-up identity, cloud-handshake).

## R3 — SHIPPED as v48 (2026-07-13) — ALL FOUR ROOTS NOW DONE
The bulk-check no longer partitions by the sweeping account; it runs against the WHOLE campaign
(every account's leads + every account's accumulated connections), exactly like the app's whole-sheet
pass. The core matcher (`campaign-bulkcheck-core.mjs`) was already a verbatim port — R3 was purely the
WRAPPER feeding it single-account data.
- **#11 cross-account acceptance** — `runBulkCheck` now feeds `store.getAllConnections(campaign.id)`
  (all accounts, each tagged `account`) + ALL monitorable leads (dropped the `assigned_profile===account`
  filter). `profileName` stays the sweeping account so sender-scoping + the `sweepingConnected` 1st-degree
  intro gate are unchanged. The matcher's cross-sender branch REASSIGNS the row's Sender to the connected
  account; mirrored via `mapUpdate` → `assignedProfile` and a new `assigned_profile` write in
  `updateLeadOutcome`. Intro fires from the reassigned account's OWN next sweep (1st-degree browser).
- **#12 urn-only acceptances** — `campaign_connections` identity moved from `public_id` PK to
  `match_key = COALESCE(publicId, urn, memberNumber)` (idempotent schema migration: add+backfill column,
  drop old PK, unique index on match_key). `upsertConnections` keeps urn-only/memberNumber-only conns
  (only truly keyless dropped) + in-batch dedup by match_key. `connMatchKey` split to pure
  `campaign-conn-identity.js` (testable without pg).
- **#15 whole-campaign dedup** — each url-keyed update applies to EVERY lead copy sharing the URL (mirrors
  google-apps-script v2.105 findRowsByUrl stamping all copies); the matcher's whole-sheet terminalIntroKeys
  pre-pass now sees all senders → same person on 2 rows collapses to ONE intro.
- **Safety proof:** the only `connectedUrls.push` (matcher line 251, in `tryQueueIntro`) is reachable only
  under `sweepingConnected` (line 473) or `!rowSenderMismatch` (aged-off retry) → `connectedUrls` can never
  contain a URL the sweeping account isn't the connected owner of, so firing intros from the sweeping
  account's browser stays valid under whole-campaign feed.
- Test: `test-r3-bulkcheck-whole-campaign.js` (6, real matcher + fake in-memory store: #11 reassign+defer,
  #12 urn-only match, #15 dedup-once, sender-scoping no-op). All pure suites green.
- **REMAINING after R3:** only the deferred, non-R-root items — #17 (dm-sent-log cross-campaign dedup, a new
  persistence subsystem) and #18 (follow-up identity, depends on the cloud primary-handshake / Path B).

## Already shipped this session (context)
- v41 check-now; v42 intro-crash fix (`_vendoredSend`); v43 personalization (partial R1: primary full
  name + company from row_data for CC+IC only — CC+DM + custom columns + leadToRow still unfixed).
- App branch `preflight-linter-2135` (unpushed): campaigns-client forwards `row`; google-apps-script
  COL_ALIASES (needs redeploy). App at v2.158.3.
