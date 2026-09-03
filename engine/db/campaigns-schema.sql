-- Campaigns durable state (Postgres / Cloud SQL). The SYSTEM OF RECORD — sends
-- must never double-fire, so the work queue lives here (atomically claimable),
-- not in pod memory. Redis holds only coordination (locks, counters, anti-dupe).
--
-- Isolated from the scraper: the scraper uses no Postgres; deleting these tables
-- (or the whole DB) never touches it.

-- One outreach job: a set of GoLogin accounts + a lead sheet + a mode.
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT        NOT NULL DEFAULT '',
  mode         TEXT        NOT NULL,                  -- connect_only (first), connect_and_introduce, ...
  status       TEXT        NOT NULL DEFAULT 'queued', -- queued|running|paused|done|cancelled|error
  owner        TEXT        NOT NULL DEFAULT '',       -- operator id
  profile_ids  JSONB       NOT NULL DEFAULT '[]',     -- GoLogin accounts this campaign may use
  sheet_url    TEXT        NOT NULL DEFAULT '',
  daily_limit  INTEGER     NOT NULL DEFAULT 50,       -- per-account daily send cap
  config       JSONB       NOT NULL DEFAULT '{}',     -- batch size, bph, etc.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each person to action. THE durable, atomically-claimable work queue.
CREATE TABLE IF NOT EXISTS leads (
  id               BIGSERIAL PRIMARY KEY,
  campaign_id      TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_url         TEXT        NOT NULL,
  member_urn       TEXT,                                  -- stable LinkedIn id (dedupe)
  full_name        TEXT        NOT NULL DEFAULT '',
  sheet_row        INTEGER,                               -- row in the source sheet (for stamping)
  status           TEXT        NOT NULL DEFAULT 'pending',-- pending|claimed|sent|skipped|error
  assigned_profile TEXT,                                  -- which account actioned it (set on claim)
  claimed_by       TEXT,                                  -- pod that claimed it
  claimed_at       TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  stage            TEXT        NOT NULL DEFAULT '',        -- the Sheet "Stage" stamp (CC/IC/...)
  error            TEXT        NOT NULL DEFAULT '',
  -- no duplicate person within a campaign (NULL urns are allowed/ignored by PG)
  UNIQUE (campaign_id, member_urn)
);
-- The hot path: "next pending lead for this campaign".
CREATE INDEX IF NOT EXISTS idx_leads_claimable ON leads (campaign_id, status, id);

-- Durable per-(account, day) send counts — the daily-limit record. Redis holds
-- the live hot counter; this is the durable mirror for reporting/recovery.
CREATE TABLE IF NOT EXISTS daily_counts (
  profile_id TEXT    NOT NULL,
  day        DATE    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day)
);

-- Scheduled work (monitoring checks, follow-ups, accepts). Phase 3 drives this;
-- the always-on frontend's scheduler claims due rows. Durable so timers survive
-- restarts (unlike the desktop app's in-memory setTimeout).
CREATE TABLE IF NOT EXISTS campaign_tasks (
  id          BIGSERIAL   PRIMARY KEY,
  campaign_id TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,                  -- monitor|follow_up|accept
  status      TEXT        NOT NULL DEFAULT 'pending',-- pending|claimed|done|error
  due_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB       NOT NULL DEFAULT '{}',
  claimed_by  TEXT,
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON campaign_tasks (status, due_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Advanced modes (CC+IC, CC+DM, introduce_back) — Phase B. Idempotent ALTERs so
-- migrate() is safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-lead advanced-mode state (mirrors the desktop app's Sheet columns). Each
-- mode owns its own terminal column; `connection_accepted_status` (cc) is the
-- acceptance verdict the monitoring loop writes.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS connection_request_status  TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS connection_accepted_status TEXT NOT NULL DEFAULT ''; -- cc: Connected|Still Pending (ts)|...
ALTER TABLE leads ADD COLUMN IF NOT EXISTS introduction_status        TEXT NOT NULL DEFAULT ''; -- one-shot terminal (CC+IC / IB)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_status                  TEXT NOT NULL DEFAULT ''; -- one-shot terminal (CC+DM)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_slug              TEXT NOT NULL DEFAULT ''; -- publicId
ALTER TABLE leads ADD COLUMN IF NOT EXISTS member_number              TEXT NOT NULL DEFAULT ''; -- numeric member id
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_name                 TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_name                  TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company                    TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS title                      TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS connected_already          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS thread_url                 TEXT NOT NULL DEFAULT ''; -- intro group-thread URL (for follow-ups)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS date_last_action           TIMESTAMPTZ;
-- Per-lead account routing (auto-routed modes: message_only / introduce_back /
-- check_status). When set, ONLY this account may claim the lead (the original
-- sender from the sheet's Account-Used column). NULL = shared-pool (any of the
-- campaign's accounts can claim it — connect_only / inmail_only / etc.).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS route_account              TEXT NOT NULL DEFAULT '';
-- Hot path: "next pending lead for this account" (partial-routing aware).
CREATE INDEX IF NOT EXISTS idx_leads_route ON leads (campaign_id, route_account, status, id);
-- Sheet write-back: set true whenever a status field changes, cleared once the
-- row's status is pushed back to the operator's Google Sheet. Decouples the
-- (slow, retryable) sheet write from the action path. Partial index = the sync
-- query only ever scans rows that actually need writing.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sheet_dirty BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_leads_dirty ON leads (campaign_id, id) WHERE sheet_dirty;
-- Full source-sheet row (column -> value) for template personalization. Local
-- uses the ENTIRE row as tokens ({company}, {title}, {Event}, any header); the
-- app sends it per lead so {custom columns} resolve instead of rendering blank.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS row_data JSONB NOT NULL DEFAULT '{}';

-- Per-campaign monitoring lifecycle (replaces the app's monitoring-state.json).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitor_state          TEXT NOT NULL DEFAULT 'sending'; -- sending|monitoring|done
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS check_interval_minutes INTEGER NOT NULL DEFAULT 60;     -- acceptance-check cadence
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_checks_enabled    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_ended_at       TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitoring_until       TIMESTAMPTZ;  -- sending_ended_at + 7d
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS next_check_at          TIMESTAMPTZ;
-- Durable monitor-check observability. A successful Voyager sweep can change no
-- lead rows, but operators still need to see that the check ran.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitor_check_started_at   TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitor_check_completed_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitor_check_newly_accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS monitor_check_error        TEXT NOT NULL DEFAULT '';

-- Per-(campaign, account) connection-to-PRIMARY state (CC+IC). Replaces the app's
-- in-memory campaign._primaryConn + primary-status.json. Gates whether intros fire.
CREATE TABLE IF NOT EXISTS campaign_primary_conn (
  campaign_id  TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  profile_id   TEXT        NOT NULL,
  state        TEXT        NOT NULL DEFAULT 'no_url', -- connected|pending|unverified|sent|no_url
  source       TEXT        NOT NULL DEFAULT 'live',   -- live|remembered
  primary_url  TEXT        NOT NULL DEFAULT '',
  last_read_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, profile_id)
);

-- Registry of PRIMARY LinkedIn accounts whose session cookies get stored so a
-- follow-up can later be sent as them on the VM. Keyed on member_id (stable
-- across slug changes); public_identifier is the lookup slug (case-insensitive).
CREATE TABLE IF NOT EXISTS campaign_primaries (
  member_id          text PRIMARY KEY,
  public_identifier  text,
  display_name       text,
  cookies            jsonb NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_campaign_primaries_slug
  ON campaign_primaries (lower(public_identifier));

-- Accumulated, SENDER-SCOPED connections seen via Voyager (replaces the app's
-- "Recent Connections" sidecar tab). computeBulkCheckUpdates matches leads
-- against this set, so acceptances that age off LinkedIn's 80-window survive.
CREATE TABLE IF NOT EXISTS campaign_connections (
  campaign_id   TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account       TEXT        NOT NULL,                  -- GoLogin profile that owns it (sender-scoping)
  public_id     TEXT        NOT NULL DEFAULT '',       -- slug (match key)
  urn           TEXT        NOT NULL DEFAULT '',
  member_number TEXT        NOT NULL DEFAULT '',
  first_name    TEXT        NOT NULL DEFAULT '',
  last_name     TEXT        NOT NULL DEFAULT '',
  connected_at  TEXT        NOT NULL DEFAULT '',
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account, public_id)
);
CREATE INDEX IF NOT EXISTS idx_conns_acct ON campaign_connections (campaign_id, account);

-- R3 (#12): the app keeps a connection even when it has NO publicId (slug) — a
-- urn-only or memberNumber-only acceptance is a real 1st-degree match. The old
-- PK (campaign_id, account, public_id) both DROPPED those rows (all collapse to
-- public_id='') and forced upsertConnections to skip them. Move identity to a
-- match_key = COALESCE(publicId, urn, memberNumber) so urn-only conns survive
-- and dedup on their strongest available key. Idempotent migration: add + backfill
-- the column, retire the public_id PK, key on match_key instead.
ALTER TABLE campaign_connections ADD COLUMN IF NOT EXISTS match_key TEXT NOT NULL DEFAULT '';
UPDATE campaign_connections
   SET match_key = COALESCE(NULLIF(public_id,''), NULLIF(urn,''), NULLIF(member_number,''), '')
 WHERE match_key = '';
ALTER TABLE campaign_connections DROP CONSTRAINT IF EXISTS campaign_connections_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conns_matchkey
  ON campaign_connections (campaign_id, account, match_key);

-- Task dedupe (accept:{profileId} / follow-up:{profileId}:{leadUrl}) — never queue
-- the same primary-task twice for a campaign.
ALTER TABLE campaign_tasks ADD COLUMN IF NOT EXISTS dedupe_key TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON campaign_tasks (campaign_id, dedupe_key) WHERE dedupe_key <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- R4 — Automatic reply detection (mirrors the app's post-campaign-reply-check.js
-- + check-dms.js checkProfileDms bulk-inbox scan). Idempotent so migrate() re-runs.
-- ─────────────────────────────────────────────────────────────────────────────

-- Inbound replies found by the recurring reply sweep. PK dedup so the SAME reply
-- found on consecutive sweeps records once — this is what replaces reading the
-- sheet back for the app's non-destructive "already replied?" guard. body_key =
-- first 80 chars of body (the dedup axis, mirrors replies-log.js replyKey's
-- String(text).slice(0,80)).
CREATE TABLE IF NOT EXISTS campaign_replies (
  campaign_id TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account     TEXT        NOT NULL,                  -- GoLogin profile that owns the thread
  lead_url    TEXT        NOT NULL DEFAULT '',
  body_key    TEXT        NOT NULL DEFAULT '',        -- first 80 chars of body (dedup axis)
  direction   TEXT        NOT NULL DEFAULT '',        -- in | out
  sender      TEXT        NOT NULL DEFAULT '',
  body        TEXT        NOT NULL DEFAULT '',
  ts          TEXT        NOT NULL DEFAULT '',
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account, lead_url, body_key)
);

-- Per-(campaign, account) Voyager watermark for the reply sweep. ms-since-epoch;
-- only conversations with lastActivityAt > watermark are "new". Mirrors the app's
-- scanSinceMs window — advanced only on a successful scan, never regressed.
CREATE TABLE IF NOT EXISTS campaign_reply_state (
  campaign_id TEXT        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account     TEXT        NOT NULL,
  watermark   BIGINT      NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, account)
);
