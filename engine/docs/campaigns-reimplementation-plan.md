# Advanced Campaign Modes — Engine Reimplementation Plan

Goal: run CC+IC, CC+DM, introduce_back, and Follower Growth on the GKE engine
(Postgres + Redis), reusing the app's page-level browser primitives but
**reimplementing the orchestration** (the app's orchestration is tied to Google
Sheets + an in-process loop; the engine uses Postgres/Redis across pods).

Built already: `connect_only`, `message_only` (Phases 0–3b), foundation lib
refreshed to app v2.120.2.

Approach: **incremental, tested per phase.** No deploy until everything is built
+ locally green (one unified `campaign-worker`).

---

## The primitives/orchestration split (from the research map)

**VENDOR byte-identical (clean — import only helpers/actions, no Sheets/campaign.js):**
- `actions.js`, `helpers.js` ✅ (done), `match-primary.js`, `intro-voyager.js`,
  `primary-connection.js`, `accept-invitation.js`, `thread-message.js`,
  `profile-identity.js`, `follower-invite.js`
- Pure-logic cores to port verbatim (preserve dedup/terminal/sender-scoping):
  `computeBulkCheckUpdates`, `leadIdentityKeys`, monitoring-time helpers
  (`computeMonitoringUntil`, `recomputeNextCheckAt`), primary-tasks pure
  builders/selectors, the auto-intro/auto-dm decision helpers.

**REIMPLEMENT on Postgres/Redis:**
- `bulkCheckConnections` wrapper (getRecentConnections → accumulated-connections
  table → computeBulkCheckUpdates → Postgres write-back)
- `runAutoIntros` / `runAutoDms` orchestration
- primary-task queue + worker (accept + follow-up)
- the `_primaryConn` per-account state machine
- scheduler trigger paths (cadence sweep, 7-day monitoring window, post-campaign
  sweep, primary-task drain)

---

## Phases

### Phase A — Vendor primitives + port pure cores  ⬅ START HERE
Vendor the clean files into `campaign-lib/`; port the pure-logic functions into
engine modules. Unit-test the pure cores (esp. `computeBulkCheckUpdates`
matching/dedup/terminal semantics — this is the hard-won correctness).

### Phase B — Data model (Postgres)
Extend `db/campaigns-schema.sql` + `campaign-store.js`:
- lead state (connection_request_status, connection_accepted_status, stage,
  introduction_status, dm_status, identity fields, sender, timestamps)
- campaign config/templates (primary person, intro/dm/follow-up bodies, cadence,
  monitoring window, auto-accept flags, sender_first_names)
- per-(campaign,profile) primary_conn state
- primary_task queue table
- accumulated_connections table (sender-scoped, survives the 80-window)
- scheduler cooldowns (or Redis)
Test: migration + store methods + state transitions.

### Phase C — Monitoring engine (core)
Bulk-check wrapper + a scheduler task: per-cadence sweep per active
(campaign, profile) → detect newly-accepted leads → mark them for follow-up.
Implements the 7-day window + cadence (default 60 min). Test with mocked
connections → assert acceptance detection + state transitions + sender-scoping.

### Phase D — CC+IC (connect_and_introduce)
Connect phase (reuse connect_only) → on acceptance, runAutoIntros reimpl:
primary-connection gate (_primaryConn machine), 3-way intro via
`sendIntroViaCleanCompose`, stamp introduction_status, enqueue follow-up.
Primary-task queue + worker (accept + delayed follow-up). Test full flow (mock).

### Phase E — CC+DM (connect_and_message)
Mirror of D minus primary; reuse monitoring; runAutoDms via `sendMessage`,
content-dedup, dm_status. Test.

### Phase F — introduce_back
Single-pass intro from already-connected (force_message + introMode). Test.

### Phase G — Follower Growth
Vendor `follower-invite.js`; build the FG action + invite-budget logic. Test.

### Phase H — Runtime entrypoint + integration
Wire `ROLE=campaign-worker` to run scheduler + worker + all modes against
Postgres/Redis. Full local integration pass across all modes.

### Phase I — GKE deploy (the actual cutover)
Cloud SQL Postgres, `campaign-worker` deployment + KEDA, image build, prod
validation run. (Deferred — no rush.)

---

## Notes
- One unified `campaign-worker` handles all modes (action factory routes by mode).
- Reuses existing engine infra: Basic Redis (account locks), N2 nodes, KEDA.
- Off-limits app files (`outreach.js`, `actions.js`) are only ever VENDORED, never edited.
