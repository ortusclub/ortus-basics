// campaign-store.js
//
// Durable + coordinated state for campaign execution on the engine.
//
//   • Postgres = system of record (campaigns, leads, daily counts, tasks). The
//     lead queue is claimed ATOMICALLY here (FOR UPDATE SKIP LOCKED) so two
//     workers can never grab the same lead → no double-sends.
//   • Redis    = coordination only: the per-account lock, the live daily-send
//     counter, and anti-dupe sets.
//
// ISOLATION / SAFETY:
//   • Campaign Redis keys are namespaced `cmp:*` — the scraper's `sn:*` keys are
//     untouched. Deleting campaign state never affects the scraper.
//   • The PER-ACCOUNT LOCK is DELIBERATELY SHARED with the scraper (key
//     `sn:proflock:<profileId>` — the same one the scraper uses). That's the
//     account-safety guarantee: a scrape and a campaign can NEVER drive the same
//     LinkedIn account at the same moment, because they contend for one lock.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// SHARED with the scraper (redis-store.js CLAIM_LUA uses `sn:proflock:`). Do not
// namespace this — sharing it is the whole point (cross-engine account safety).
const ACCT_LOCK_PREFIX = "sn:proflock:";
const ACCT_LOCK_TTL_SEC = 120;

// R3 (#12): connection dedup/match identity — pure, split into its own module so
// it's unit-testable without loading pg/ioredis.
const { connMatchKey } = require("./campaign-conn-identity.js");

const RELEASE_LUA =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const HEARTBEAT_LUA =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) else return 0 end";
// Atomic daily-send gate: increment only if still under the limit. Returns
// {consumed(0|1), count}.
const DAILY_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, n} end
n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 172800)
return {1, n}`;

// Refund one consumed daily send (for a NON-send outcome — e.g. the connect
// discovered the lead was already 1st-degree, so no invite went out). DECR
// preserves the key's TTL; the >0 guard prevents underflow.
const DAILY_REFUND_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n <= 0 then return 0 end
return redis.call('DECR', KEYS[1])`;

class CampaignStore {
  // redisClient: pass a shared ioredis (so it's the SAME Redis the scraper uses).
  constructor({ pgUrl, redis, podId }) {
    this.podId = podId || process.env.POD_NAME || process.env.HOSTNAME || "pod";
    this.pg = new Pool({ connectionString: pgUrl });
    this.redis = redis; // shared ioredis instance
  }

  async migrate() {
    const sql = fs.readFileSync(path.join(__dirname, "db", "campaigns-schema.sql"), "utf8");
    await this.pg.query(sql);
  }

  // ─── Campaigns ──────────────────────────────────────────────────────────────
  async createCampaign(c) {
    const { rows } = await this.pg.query(
      `INSERT INTO campaigns (id,name,mode,status,owner,profile_ids,sheet_url,daily_limit,config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [c.id, c.name || "", c.mode, c.status || "queued", c.owner || "",
       JSON.stringify(c.profileIds || []), c.sheetUrl || "", c.dailyLimit ?? 50,
       JSON.stringify(c.config || {})]
    );
    return rows[0];
  }
  async setCampaignStatus(id, status) {
    await this.pg.query(`UPDATE campaigns SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
  }
  // Update the per-account daily send cap (e.g. the operator edited it before a
  // restart). Ignored if not a positive integer.
  async setDailyLimit(id, dailyLimit) {
    const n = Math.floor(Number(dailyLimit));
    if (!Number.isFinite(n) || n <= 0) return;
    await this.pg.query(`UPDATE campaigns SET daily_limit=$2, updated_at=now() WHERE id=$1`, [id, n]);
  }
  async getCampaign(id) {
    const { rows } = await this.pg.query(`SELECT * FROM campaigns WHERE id=$1`, [id]);
    return rows[0] || null;
  }

  // Campaigns the runtime should be driving (send phase or FG batches). Monitoring
  // campaigns are excluded — their work arrives via campaign_tasks, not this poll.
  async getActiveCampaigns() {
    const { rows } = await this.pg.query(
      `SELECT * FROM campaigns WHERE status IN ('queued','running') ORDER BY created_at`
    );
    return rows;
  }

  // ─── Leads ──────────────────────────────────────────────────────────────────
  async addLeads(campaignId, leads) {
    if (!leads.length) return 0;
    // Postgres caps bind params at 65535 per statement (16-bit count). 6 params/lead,
    // so a single INSERT tops out ~10920 leads before the count overflows and wraps
    // to a bogus "N parameter formats but 0 parameters" error. Team-wide FG sends far
    // more — batch the insert to stay well under the cap.
    const CHUNK = 1000; // 6000 params/batch
    let total = 0;
    for (let start = 0; start < leads.length; start += CHUNK) {
      const batch = leads.slice(start, start + CHUNK);
      const values = [];
      const params = [];
      // routeAccount (optional): pins the lead to one account (auto-routed modes).
      // row (optional): the full source-sheet row for template tokens.
      batch.forEach((l, i) => {
        const b = i * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(campaignId, l.leadUrl, l.memberUrn || null, l.fullName || "", l.routeAccount || "", JSON.stringify(l.row || {}));
      });
      // ON CONFLICT: skip duplicate person in the same campaign (idempotent re-add).
      const { rowCount } = await this.pg.query(
        `INSERT INTO leads (campaign_id, lead_url, member_urn, full_name, route_account, row_data)
         VALUES ${values.join(",")}
         ON CONFLICT (campaign_id, member_urn) DO NOTHING`,
        params
      );
      total += rowCount;
    }
    return total;
  }

  // On start/import: a lead whose sheet row ALREADY carries a "Connection Request
  // Status" was actioned in a prior run — a request was sent, it was already
  // connected, or it errored. It must NOT be re-sent: there is no reason to
  // re-open that profile. Mark every such freshly-imported lead status='sent' so
  // the worker never claims it, while seeding its sheet connect/accept/intro state
  // so it stays MONITORABLE (accepted-but-not-introduced ones are then picked up by
  // the intro backlog). assigned_profile is resolved from the row's "Account Used"
  // email via the campaign's accountEmails map (passed reversed as email→profileId)
  // so the acceptance monitor attributes each lead to the account that sent it.
  // Only touches status='pending' rows, so it's a safe no-op on re-imports.
  // Returns the number of leads skipped. Connect modes only (the caller gates).
  async markPreActionedConnectLeads(campaignId, emailToPid = {}) {
    const { rowCount } = await this.pg.query(
      `UPDATE leads SET
          status = 'sent',
          connection_request_status  = btrim(COALESCE(row_data->>'Connection Request Status', row_data->>'connection request status','')),
          connection_accepted_status = COALESCE(NULLIF(btrim(row_data->>'Connection Accepted Status'),''), connection_accepted_status),
          introduction_status        = COALESCE(NULLIF(btrim(row_data->>'Introduction Status'),''), introduction_status),
          assigned_profile           = COALESCE($2::jsonb ->> lower(btrim(row_data->>'Account Used')), NULLIF(assigned_profile,''), assigned_profile),
          stage                      = 'pre-actioned'
        WHERE campaign_id=$1 AND status='pending'
          AND btrim(COALESCE(row_data->>'Connection Request Status', row_data->>'connection request status','')) <> ''`,
      [campaignId, JSON.stringify(emailToPid || {})]
    );
    return rowCount;
  }

  // Cross-campaign pre-skip (Sam 2026-07-24): a lead can be blank in THIS
  // campaign's imported row snapshot yet already actioned by a SIBLING campaign
  // on the SAME sheet (e.g. duplicate launches of one campaign — the sibling
  // sent the invite and stamped the sheet after this campaign imported).
  // Observed: "already invited (skipped)" turns that opened a profile for
  // nothing. Flip any pending lead whose lead_url/member_urn was actioned by
  // another campaign sharing this sheet_url — same semantics as
  // markPreActionedConnectLeads (status='sent', stage='pre-actioned', never
  // re-opened, monitorable). Returns the number skipped.
  async markCrossCampaignActionedLeads(campaignId, sheetUrl) {
    if (!sheetUrl || !String(sheetUrl).trim()) return 0;
    const { rowCount } = await this.pg.query(
      `UPDATE leads l SET
          status = 'sent',
          stage = 'pre-actioned',
          connection_request_status = o.crs,
          connection_accepted_status = COALESCE(NULLIF(btrim(o.cas),''), l.connection_accepted_status),
          introduction_status        = COALESCE(NULLIF(btrim(o.ist),''), l.introduction_status),
          assigned_profile           = COALESCE(NULLIF(l.assigned_profile,''), o.assigned_profile)
        FROM (
          SELECT DISTINCT ON (l2.lead_url) l2.lead_url, l2.member_urn,
                 COALESCE(NULLIF(btrim(l2.connection_request_status),''), 'Connection Request Sent') AS crs,
                 l2.connection_accepted_status AS cas, l2.introduction_status AS ist,
                 l2.assigned_profile
            FROM leads l2 JOIN campaigns c2 ON c2.id = l2.campaign_id
           WHERE c2.sheet_url = $2 AND c2.id <> $1
             AND ( (l2.status = 'sent' AND l2.sent_at IS NOT NULL)
                OR btrim(COALESCE(l2.connection_request_status,'')) <> '' )
           ORDER BY l2.lead_url, l2.id DESC
        ) o
        WHERE l.campaign_id = $1 AND l.status = 'pending'
          AND ( l.lead_url = o.lead_url
             OR (l.member_urn IS NOT NULL AND l.member_urn = o.member_urn) )`,
      [campaignId, sheetUrl]
    );
    return rowCount;
  }

  // ATOMIC claim of the next pending lead for a campaign. FOR UPDATE SKIP LOCKED
  // means two workers (even on different accounts) NEVER get the same lead — the
  // durable-queue equivalent of the scraper's atomic claim-lock.
  async claimNextLead(campaignId, profileId) {
    // route_account gate: a routed lead (route_account <> '') is claimable ONLY
    // by its pinned account; an unrouted lead (route_account = '') is claimable
    // by any account (shared pool). So this account claims: its own routed leads
    // OR any unrouted lead.
    const { rows } = await this.pg.query(
      `UPDATE leads SET status='claimed', assigned_profile=$2, claimed_by=$3, claimed_at=now()
       WHERE id = (
         SELECT id FROM leads
         WHERE campaign_id=$1 AND status='pending'
           AND (route_account = '' OR route_account = $2)
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [campaignId, profileId, this.podId]
    );
    return rows[0] || null;
  }

  async markLead(id, status, patch = {}) {
    // sheet_dirty: a terminal outcome (sent/skipped/error) should be reflected
    // in the operator's Sheet; a plain re-claim (status='claimed'/'pending')
    // shouldn't trigger a write.
    const dirty = status === "sent" || status === "skipped" || status === "error";
    await this.pg.query(
      `UPDATE leads SET status=$2,
         stage=COALESCE($3,stage), error=COALESCE($4,error),
         sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END,
         -- error/skip moment: gives the app's log a timestamp for ✗ lines (sent
         -- leads carry sent_at) and the sheet writer a Date/Time of Last Action.
         date_last_action=CASE WHEN $2 IN ('error','skipped') THEN now() ELSE date_last_action END,
         sheet_dirty=CASE WHEN $5 THEN true ELSE sheet_dirty END
       WHERE id=$1`,
      [id, status, patch.stage ?? null, patch.error ?? null, dirty]
    );
  }

  // Put a claimed lead back in the queue (e.g. the account hit its daily cap, so
  // another account / tomorrow should action it). Idempotent.
  async releaseLeadToPending(id) {
    await this.pg.query(
      `UPDATE leads SET status='pending', assigned_profile=NULL, claimed_by=NULL, claimed_at=NULL
       WHERE id=$1 AND status='claimed'`,
      [id]
    );
  }

  async pendingLeadCount(campaignId) {
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n FROM leads WHERE campaign_id=$1 AND status='pending'`,
      [campaignId]
    );
    return rows[0].n;
  }

  async leadStatusCounts(campaignId) {
    const { rows } = await this.pg.query(
      `SELECT status, count(*)::int AS n FROM leads WHERE campaign_id=$1 GROUP BY status`,
      [campaignId]
    );
    const out = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    // Pre-actioned leads (sheet already had a Connection Request Status on
    // import — see markPreActionedConnectLeads) sit in status='sent' so the
    // worker never claims them, but they are NOT part of this run's workload.
    // Report them under _preActioned so the app can exclude them from the
    // "X of Y sent" progress display.
    const pre = await this.pg.query(
      `SELECT count(*)::int AS n FROM leads WHERE campaign_id=$1 AND stage='pre-actioned'`,
      [campaignId]
    );
    if (pre.rows[0] && pre.rows[0].n) out._preActioned = pre.rows[0].n;
    return out;
  }

  // ─── Scheduled tasks (durable timers: monitoring, follow-ups) ────────────────
  // dedupeKey (optional): accept:{profileId} / follow-up:{profileId}:{leadUrl} —
  // an ON CONFLICT no-op so the same primary-task is never queued twice. Returns
  // null when deduped. Tasks without a dedupeKey (e.g. monitor) always insert.
  async createTask({ campaignId, type, dueAt, payload, dedupeKey }) {
    const { rows } = await this.pg.query(
      `INSERT INTO campaign_tasks (campaign_id, type, due_at, payload, dedupe_key)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (campaign_id, dedupe_key) WHERE dedupe_key <> '' DO NOTHING
       RETURNING *`,
      [campaignId, type, dueAt || new Date(), JSON.stringify(payload || {}), dedupeKey || ""]
    );
    return rows[0] || null; // null = deduped (a pending/active task already exists)
  }

  // Atomically claim the next DUE pending task (due_at <= now). FOR UPDATE SKIP
  // LOCKED → across scheduler pods, a due task is dispatched exactly once. This
  // is the durable replacement for the desktop app's in-memory setTimeout/cron.
  async claimNextDueTask() {
    const { rows } = await this.pg.query(
      `UPDATE campaign_tasks SET status='claimed', claimed_by=$1, claimed_at=now()
       WHERE id = (
         SELECT id FROM campaign_tasks
         WHERE status='pending' AND due_at <= now()
           AND NOT (type='follow_up' AND payload->>'sender' = 'local-browser')
         ORDER BY due_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [this.podId]
    );
    return rows[0] || null;
  }

  // Recover follow_up/accept tasks orphaned in status='claimed' by a pod that
  // died between claim and mark (monitor/reply self-revive via armMonitorTask;
  // these don't). due_at is already past, so flipping status back to pending
  // makes the row immediately re-claimable — do NOT touch due_at.
  async reapOrphanedTasks(maxClaimedMs = 10 * 60 * 1000) {
    const { rows } = await this.pg.query(
      `UPDATE campaign_tasks
          SET status='pending', claimed_by=NULL, claimed_at=NULL
        WHERE type IN ('follow_up','accept')
          AND status='claimed'
          AND claimed_at < now() - ($1::int * interval '1 millisecond')
        RETURNING id`,
      [maxClaimedMs]
    );
    return { reaped: rows.length };
  }

  async markTask(id, status) {
    await this.pg.query(`UPDATE campaign_tasks SET status=$2 WHERE id=$1`, [id, status]);
  }

  // Reschedule a recurring task (e.g. the next monitoring check in 30 min).
  async rescheduleTask(id, dueAt) {
    await this.pg.query(
      `UPDATE campaign_tasks SET status='pending', due_at=$2, claimed_by=NULL, claimed_at=NULL WHERE id=$1`,
      [id, dueAt]
    );
  }

  // Arm (create-or-revive) a campaign's recurring monitor task so it's due at
  // `dueAt`. createTask is ON CONFLICT DO NOTHING, so it can't revive a monitor
  // row that already ran to completion (needed after a 'park', for Check-now, or
  // when toggling auto-checks back on). This upsert flips the existing
  // monitor:<id> row back to pending @ dueAt, or inserts it if absent.
  // `scope` selects which accounts the resulting sweep opens a browser for:
  //   "campaign" (default) → the campaign's own profile_ids
  //   "all"                → every unique account in the sheet's "Account Used"
  //                          column (assigned_profile on the leads), unioned with
  //                          profile_ids. Carried on the monitor task's payload so
  //                          handleMonitor can read it; the recurring reschedule
  //                          resets it to "campaign" (see resetMonitorTaskScope) so
  //                          a one-off "check all" never leaks into auto-checks.
  async armMonitorTask(campaignId, dueAt = new Date(), scope = "campaign") {
    await this.pg.query(
      `INSERT INTO campaign_tasks (campaign_id, type, due_at, payload, dedupe_key)
       VALUES ($1,'monitor',$2,$4::jsonb,$3)
       ON CONFLICT (campaign_id, dedupe_key) WHERE dedupe_key <> ''
       DO UPDATE SET status='pending', due_at=EXCLUDED.due_at, payload=EXCLUDED.payload, claimed_by=NULL, claimed_at=NULL`,
      [campaignId, dueAt, `monitor:${campaignId}`, JSON.stringify({ scope: scope === "all" ? "all" : "campaign" })]
    );
  }

  // Revert a monitor task's payload scope back to "campaign" after a one-shot
  // "check all accounts" sweep, so the next recurring auto-check (which reuses this
  // same task row via rescheduleTask, preserving payload) doesn't keep sweeping the
  // wider account set. No-op if the row is absent.
  async resetMonitorTaskScope(campaignId) {
    await this.pg.query(
      `UPDATE campaign_tasks
          SET payload = jsonb_set(COALESCE(payload,'{}'::jsonb), '{scope}', '"campaign"')
        WHERE campaign_id=$1 AND type='monitor'`,
      [campaignId]
    );
  }

  async dueTaskCount() {
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n FROM campaign_tasks WHERE status='pending' AND due_at <= now()`
    );
    return rows[0].n;
  }

  // ─── Shared per-account lock (cross-safe with the scraper) ───────────────────
  async acquireAccount(profileId) {
    const ok = await this.redis.set(`${ACCT_LOCK_PREFIX}${profileId}`, this.podId, "NX", "EX", ACCT_LOCK_TTL_SEC);
    return ok === "OK";
  }
  async heartbeatAccount(profileId) {
    return this.redis.eval(HEARTBEAT_LUA, 1, `${ACCT_LOCK_PREFIX}${profileId}`, this.podId, String(ACCT_LOCK_TTL_SEC));
  }
  async releaseAccount(profileId) {
    return this.redis.eval(RELEASE_LUA, 1, `${ACCT_LOCK_PREFIX}${profileId}`, this.podId);
  }
  async isAccountLocked(profileId) {
    return (await this.redis.exists(`${ACCT_LOCK_PREFIX}${profileId}`)) === 1;
  }

  // ─── Daily send limit (atomic, per account+day) ──────────────────────────────
  // Consumes one send if under the limit. Returns { allowed, count }.
  async tryConsumeDailySend(profileId, day, limit) {
    const res = await this.redis.eval(DAILY_LUA, 1, `cmp:dailycount:${profileId}:${day}`, String(limit));
    return { allowed: res[0] === 1, count: res[1] };
  }

  async dailyCount(profileId, day) {
    return Number((await this.redis.get(`cmp:dailycount:${profileId}:${day}`)) || 0);
  }

  // Give back a daily send consumed by tryConsumeDailySend when the action turned
  // out NOT to be a send (already-connected lead). 1:1 with local, which never
  // counts a skip against the daily cap. Idempotent-safe (won't go below 0).
  async refundDailySend(profileId, day) {
    return this.redis.eval(DAILY_REFUND_LUA, 1, `cmp:dailycount:${profileId}:${day}`);
  }

  // Follower Growth budget: invites are a MONTHLY per-account LinkedIn credit
  // (refills monthly), unlike the daily caps above. Counted across ALL campaigns
  // from the leads table (source of truth), so a restart can never forget spend.
  // `month` is 'YYYY-MM'.
  async invitedCountForMonth(account, month) {
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n FROM leads
       WHERE assigned_profile=$1 AND stage='Invited'
         AND sent_at >= to_date($2,'YYYY-MM')
         AND sent_at <  to_date($2,'YYYY-MM') + interval '1 month'`,
      [account, month]
    );
    return rows[0].n;
  }

  // ─── 429 / throttle parking (per account, cross-pod) ─────────────────────────
  // A throttled account must stop sending, not machine-gun its batch. We count
  // consecutive 429s; at `threshold` the account is PARKED (a key with a cooldown
  // TTL) so no worker acquires it until the cooldown lapses.
  // reason: "throttle" (transient 429) or "weekly" (weekly invite cap). Stored as
  // the park key's VALUE so the app can show WHY an account paused. TTL unchanged.
  async recordThrottle(account, threshold = 2, cooldownSec = 1800, reason = "throttle") {
    const count = await this.redis.incr(`cmp:429:${account}`);
    // Streak TTL is LONGER than the park (6h floor): an account that 429s, parks
    // 30 min, comes back and 429s again must keep counting UP — with the old
    // TTL(=cooldownSec) the streak often expired during the park, so a
    // weekly-capped account cycled 429→park→429 forever without ever
    // accumulating the evidence. The streak still resets on a clean send.
    await this.redis.expire(`cmp:429:${account}`, Math.max(cooldownSec, 6 * 3600));
    let parked = false;
    if (count >= threshold) {
      await this.redis.set(`cmp:park:${account}`, String(reason || "throttle"), "EX", cooldownSec);
      parked = true;
    }
    return { count, parked };
  }
  // Reset the 429 streak after a clean send.
  async clearThrottle(account) {
    await this.redis.del(`cmp:429:${account}`);
  }
  // Operator "Retry" for a benched account: clear the weekly-cap flag, the park,
  // and the 429 streak so the account is immediately eligible again. If LinkedIn
  // is still capping it, the next turns re-bench it via the same escalation.
  async unbenchAccount(account) {
    await this.redis.del(`cmp:weeklycap:${account}`, `cmp:park:${account}`, `cmp:429:${account}`);
  }
  async isParked(account) {
    return (await this.redis.exists(`cmp:park:${account}`)) === 1;
  }
  // Why the account is parked ("throttle" | "weekly"), or "" if not parked.
  async getParkReason(account) {
    return (await this.redis.get(`cmp:park:${account}`)) || "";
  }

  // ─── Needs-login flag (per account) ──────────────────────────────────────────
  // Set when a send/monitor hits a dead LinkedIn session (the operator must
  // re-login in GoLogin). Longer TTL than a park — it stays flagged until a clean
  // send clears it (or 7 days lapse), so the app's account panel can show it.
  async setNeedsLogin(account) {
    await this.redis.set(`cmp:needslogin:${account}`, String(Date.now()), "EX", 7 * 24 * 3600);
  }
  async clearNeedsLogin(account) {
    await this.redis.del(`cmp:needslogin:${account}`);
  }
  async isNeedsLogin(account) {
    return (await this.redis.exists(`cmp:needslogin:${account}`)) === 1;
  }

  // ─── Weekly invite-cap flag (per account) ────────────────────────────────────
  // A 30-min 429 park is too short to represent LinkedIn's WEEKLY invite cap, which
  // lasts until the week rolls over. So when a weekly-cap 429 is seen we set this
  // longer-lived flag (7-day TTL) so the app can show "weekly cap reached" the whole
  // time. Cleared on a clean send (a successful invite means the cap has lifted).
  async setWeeklyCap(account) {
    await this.redis.set(`cmp:weeklycap:${account}`, String(Date.now()), "EX", 7 * 24 * 3600);
  }
  async clearWeeklyCap(account) {
    await this.redis.del(`cmp:weeklycap:${account}`);
  }
  async isWeeklyCap(account) {
    return (await this.redis.exists(`cmp:weeklycap:${account}`)) === 1;
  }

  // Aggregate per-account status for a campaign's accounts — powers the app's
  // Live Status account panel. Returns [{ profileId, dailyCount, dailyLimit,
  // parked, parkReason, needsLogin }]. Read-only; safe to poll.
  async accountStatuses(profileIds = [], day, dailyLimit = 0) {
    const out = [];
    for (const profileId of profileIds) {
      const [dailyCount, parkReason, needsLogin, weeklyCap] = await Promise.all([
        this.dailyCount(profileId, day),
        this.getParkReason(profileId),
        this.isNeedsLogin(profileId),
        this.isWeeklyCap(profileId),
      ]);
      out.push({
        profileId,
        dailyCount: Number(dailyCount) || 0,
        dailyLimit: Number(dailyLimit) || 0,
        parked: !!parkReason,
        parkReason: parkReason || "",
        needsLogin: !!needsLogin,
        weeklyCap: !!weeklyCap,
      });
    }
    return out;
  }

  // ─── Account rotation (1:1 with local's rotating worker pool) ────────────────
  // Local (src/campaign.js) rotates accounts two ways: (1) a queue that re-enqueues
  // each profile at the BACK after its turn — so the next turn naturally picks a
  // DIFFERENT account, and (2) a per-profile TURN_COOLDOWN_FLOOR (6 min) set at
  // turn-end. Together they interleave batches (A×8 → B×8 → A×8) and floor the
  // pace when the pool shrinks to one account. The cloud worker scanned profile_ids
  // from index 0 every turn, so it re-grabbed the first account until it drained —
  // "does it all one after another in a row". These two primitives restore parity.

  // (1) Round-robin cursor — atomic INCR is fair across cooperating pods (the shared
  // account lock still guarantees no double-drive). The worker starts its scan at
  // `cursor % N`, so each turn begins at the next account, like local's back-enqueue.
  async nextRotationIndex(campaignId) {
    return this.redis.incr(`cmp:rr:${campaignId}`);
  }

  // (2) Per-account between-batch cooldown — mirrors local's TURN_COOLDOWN_FLOOR_MS.
  // Set at turn-end for send (gated) modes; the selection loop skips a cooling
  // account. Separate key from cmp:park (429/dead-session, 30 min) — different reason.
  async setTurnCooldown(account, cooldownSec) {
    if (!(cooldownSec > 0)) return;
    await this.redis.set(`cmp:turncd:${account}`, String(Date.now()), "EX", Math.ceil(cooldownSec));
  }
  async inTurnCooldown(account) {
    return (await this.redis.exists(`cmp:turncd:${account}`)) === 1;
  }
  // Explicit park (e.g. a dead LinkedIn session) — no 429 counting.
  async parkAccount(account, cooldownSec = 1800, reason = "session") {
    await this.redis.set(`cmp:park:${account}`, String(reason || "session"), "EX", cooldownSec);
  }
  async parkTtl(account) {
    return this.redis.ttl(`cmp:park:${account}`); // seconds left, -2 if not parked
  }

  // ─── Anti-dupe: never send the same action to the same lead twice ────────────
  async markActionSent(campaignId, leadKey, action) {
    return this.redis.sadd(`cmp:sent:${campaignId}:${action}`, leadKey);
  }
  async wasActionSent(campaignId, leadKey, action) {
    return (await this.redis.sismember(`cmp:sent:${campaignId}:${action}`, leadKey)) === 1;
  }

  // ─── Advanced-mode lead state (CC+IC / CC+DM / introduce_back) ───────────────
  // Partial update — only provided fields change (COALESCE). Stamps date_last_action.
  async updateLeadOutcome(id, f = {}) {
    await this.pg.query(
      `UPDATE leads SET
         connection_request_status  = COALESCE($2,  connection_request_status),
         connection_accepted_status = COALESCE($3,  connection_accepted_status),
         introduction_status        = COALESCE($4,  introduction_status),
         dm_status                  = COALESCE($5,  dm_status),
         stage                      = COALESCE($6,  stage),
         connected_already          = COALESCE($7,  connected_already),
         thread_url                 = COALESCE($8,  thread_url),
         linkedin_slug              = COALESCE($9,  linkedin_slug),
         member_number              = COALESCE($10, member_number),
         assigned_profile           = COALESCE($11, assigned_profile),
         date_last_action           = now(),
         sheet_dirty                = true
       WHERE id=$1`,
      [id, f.connectionRequestStatus ?? null, f.connectionAcceptedStatus ?? null,
       f.introductionStatus ?? null, f.dmStatus ?? null, f.stage ?? null,
       f.connectedAlready ?? null, f.threadUrl ?? null, f.slug ?? null,
       f.memberNumber ?? null, f.assignedProfile ?? null]
    );
  }

  // ─── Sheet write-back ────────────────────────────────────────────────────────
  // Leads whose status changed since the last push to the operator's Sheet.
  async getLeadsNeedingSheetSync(campaignId, limit = 200) {
    const { rows } = await this.pg.query(
      `SELECT * FROM leads WHERE campaign_id=$1 AND sheet_dirty ORDER BY id LIMIT $2`,
      [campaignId, limit]
    );
    return rows;
  }
  // Clear the dirty flag once a row's status is safely written to the Sheet.
  async markLeadsSheetSynced(ids) {
    if (!ids || !ids.length) return;
    await this.pg.query(`UPDATE leads SET sheet_dirty=false WHERE id = ANY($1::bigint[])`, [ids]);
  }

  // Leads for a campaign (optionally by status) — feeds the bulk-check matcher
  // and reporting.
  async getCampaignLeads(campaignId, { status } = {}) {
    const { rows } = await this.pg.query(
      `SELECT * FROM leads WHERE campaign_id=$1 ${status ? "AND status=$2" : ""} ORDER BY id`,
      status ? [campaignId, status] : [campaignId]
    );
    return rows;
  }

  // ─── Per-(campaign, account) connection-to-PRIMARY state (CC+IC gate) ─────────
  async getPrimaryConn(campaignId, profileId) {
    const { rows } = await this.pg.query(
      `SELECT * FROM campaign_primary_conn WHERE campaign_id=$1 AND profile_id=$2`,
      [campaignId, profileId]
    );
    return rows[0] || null;
  }
  async setPrimaryConn(campaignId, profileId, state, opts = {}) {
    const { rows } = await this.pg.query(
      `INSERT INTO campaign_primary_conn (campaign_id,profile_id,state,source,primary_url,last_read_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,now(),now())
       ON CONFLICT (campaign_id,profile_id) DO UPDATE SET
         state=EXCLUDED.state, source=EXCLUDED.source,
         primary_url=COALESCE(NULLIF(EXCLUDED.primary_url,''), campaign_primary_conn.primary_url),
         last_read_at=now(), updated_at=now()
       RETURNING *`,
      [campaignId, profileId, state, opts.source || "live", opts.primaryUrl || ""]
    );
    return rows[0];
  }

  // ─── PRIMARY account registry (session cookies for VM follow-up sends) ────────
  async upsertPrimarySession({ memberId, publicIdentifier, displayName, cookies }) {
    const { rows } = await this.pg.query(
      `INSERT INTO campaign_primaries (member_id,public_identifier,display_name,cookies,captured_at,state)
       VALUES ($1,$2,$3,$4,now(),'live')
       ON CONFLICT (member_id) DO UPDATE SET
         public_identifier=EXCLUDED.public_identifier, display_name=EXCLUDED.display_name,
         cookies=EXCLUDED.cookies, captured_at=now(), state='live'
       RETURNING *`,
      [memberId, publicIdentifier || "", displayName || "", JSON.stringify(cookies || [])]
    );
    return rows[0];
  }
  async getPrimaryByMember(memberId) {
    const { rows } = await this.pg.query(`SELECT * FROM campaign_primaries WHERE member_id=$1`, [memberId]);
    return rows[0] || null;
  }
  async getPrimaryBySlug(publicIdentifier) {
    const { rows } = await this.pg.query(
      `SELECT * FROM campaign_primaries WHERE lower(public_identifier)=lower($1)`,
      [publicIdentifier]
    );
    return rows[0] || null;
  }
  async setPrimaryState(memberId, state) {
    await this.pg.query(`UPDATE campaign_primaries SET state=$2 WHERE member_id=$1`, [memberId, state]);
  }

  // Due personal-primary follow-ups for one owner's campaigns — the app drains
  // these locally (the VM never sends a personal follow-up: LinkedIn invalidates
  // a personal session replayed from a datacenter IP). Join to campaigns for
  // owner scope + sheet_url.
  async getPendingLocalFollowups(owner) {
    const { rows } = await this.pg.query(
      `SELECT t.id AS task_id, t.campaign_id, t.payload, c.sheet_url
         FROM campaign_tasks t
         JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.type='follow_up' AND t.status='pending' AND t.due_at <= now()
          AND t.payload->>'sender' = 'local-browser'
          AND c.owner = $1
        ORDER BY t.due_at`,
      [owner]
    );
    return rows.map((r) => ({ taskId: r.task_id, campaignId: r.campaign_id, sheetUrl: r.sheet_url || "", payload: r.payload || {} }));
  }

  // Mark personal follow-ups handed to the owner's app. 'delegated' = sent
  // locally: not 'pending' (never re-offered / never claimed by the VM) and
  // distinct from 'done' for auditability. Owner-scoped (symmetric with the GET)
  // so a stray/foreign task id can't strand another owner's follow-up.
  async delegateLocalFollowups(taskIds, owner) {
    const ids = (Array.isArray(taskIds) ? taskIds : []).filter((v) => /^\d+$/.test(String(v))).map(Number);
    if (!ids.length || !owner) return { delegated: 0 };
    const { rowCount } = await this.pg.query(
      `UPDATE campaign_tasks SET status='delegated'
        WHERE id = ANY($1::bigint[]) AND type='follow_up' AND payload->>'sender'='local-browser'
          AND campaign_id IN (SELECT id FROM campaigns WHERE owner=$2)`,
      [ids, owner]
    );
    return { delegated: rowCount };
  }

  // Status-payload projection of a campaign's primary session, keyed off
  // campaign.config.primaryUrl (the templates jsonb — there is no primary_url
  // column on campaigns). No slug or no captured row → 'none' (covers a
  // GoLogin-primary campaign, which never uploads a session).
  async getPrimarySessionStatus(campaign) {
    const slug = String(campaign?.config?.primaryUrl || "").match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase() || "";
    if (!slug) return { state: "none", name: "", parked: 0 };
    const row = await this.getPrimaryBySlug(slug);
    if (!row) return { state: "none", name: "", parked: 0 };
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n FROM campaign_tasks
        WHERE campaign_id=$1 AND type='follow_up' AND status='pending' AND due_at > now()`,
      [campaign.id]
    );
    return { state: row.state, name: row.display_name || "", parked: rows[0].n };
  }

  // Un-park follow_up tasks that were waiting on this primary's session (pulls
  // their due_at to now — status stays 'pending', the scheduler picks them up
  // on its normal poll). Returns the count moved.
  async resumeParkedFollowups(publicIdentifier) {
    const { rowCount } = await this.pg.query(
      `UPDATE campaign_tasks
          SET due_at = now()
        WHERE type = 'follow_up'
          AND status = 'pending'
          AND payload->>'sender' = 'local-browser'
          AND lower(payload->>'primaryUrl') LIKE '%/in/' || lower($1) || '%'`,
      [publicIdentifier]
    );
    return { resumed: rowCount };
  }

  // ─── Accumulated, sender-scoped connections (the bulk-check match set) ────────
  async upsertConnections(campaignId, account, conns) {
    if (!conns || !conns.length) return 0;
    // R3 (#12): key on match_key = COALESCE(publicId, urn, memberNumber). Keep
    // urn-only / memberNumber-only connections (the app does) — only truly
    // keyless rows (no id at all) are dropped. Dedup within this batch by
    // match_key so a multi-row VALUES insert never trips the unique index.
    const cols = 8; // campaign_id, account, match_key, public_id, urn, member_number, first_name, last_name
    const seen = new Set();
    const values = []; const params = [];
    for (const c of conns) {
      const mk = connMatchKey(c);
      if (!mk || seen.has(mk)) continue;
      seen.add(mk);
      const b = params.length;
      values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
      params.push(campaignId, account, mk, (c.publicId || c.public_id || ""),
        c.urn || "", String(c.memberNumber || c.member_number || ""),
        c.firstName || c.first_name || "", c.lastName || c.last_name || "");
    }
    if (!params.length) return 0;
    await this.pg.query(
      `INSERT INTO campaign_connections (campaign_id,account,match_key,public_id,urn,member_number,first_name,last_name)
       VALUES ${values.join(",")}
       ON CONFLICT (campaign_id,account,match_key) DO UPDATE SET
         public_id=EXCLUDED.public_id, urn=EXCLUDED.urn, member_number=EXCLUDED.member_number,
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, seen_at=now()`,
      params
    );
    return params.length / cols;
  }
  // Returns conns in getRecentConnections shape so computeBulkCheckUpdates matches.
  async getConnections(campaignId, account) {
    const { rows } = await this.pg.query(
      `SELECT public_id AS "publicId", urn, member_number AS "memberNumber",
              first_name AS "firstName", last_name AS "lastName",
              connected_at AS "connectedAt", account
         FROM campaign_connections WHERE campaign_id=$1 AND account=$2`,
      [campaignId, account]
    );
    return rows;
  }
  // R3 (#11/#15): the WHOLE-campaign connection set — every account's accepted
  // connections, each tagged with its owning `account`. This is what the app's
  // bulk-check matches against (the accumulated Recent-Connections tab spans all
  // senders), enabling cross-account acceptance detection + cross-account dedup.
  async getAllConnections(campaignId) {
    const { rows } = await this.pg.query(
      `SELECT public_id AS "publicId", urn, member_number AS "memberNumber",
              first_name AS "firstName", last_name AS "lastName",
              connected_at AS "connectedAt", account
         FROM campaign_connections WHERE campaign_id=$1`,
      [campaignId]
    );
    return rows;
  }

  // ─── Campaign monitoring lifecycle ───────────────────────────────────────────
  async setMonitorState(campaignId, f = {}) {
    await this.pg.query(
      `UPDATE campaigns SET
         monitor_state          = COALESCE($2, monitor_state),
         check_interval_minutes = COALESCE($3, check_interval_minutes),
         auto_checks_enabled    = COALESCE($4, auto_checks_enabled),
         sending_ended_at       = COALESCE($5, sending_ended_at),
         monitoring_until       = COALESCE($6, monitoring_until),
         next_check_at          = COALESCE($7, next_check_at),
         updated_at = now()
       WHERE id=$1`,
      [campaignId, f.monitorState ?? null, f.checkIntervalMinutes ?? null,
       f.autoChecksEnabled ?? null, f.sendingEndedAt ?? null,
       f.monitoringUntil ?? null, f.nextCheckAt ?? null]
    );
  }

  async recordMonitorCheckStarted(campaignId) {
    await this.pg.query(
      `UPDATE campaigns SET monitor_check_started_at=now(), monitor_check_completed_at=NULL,
         monitor_check_newly_accepted=0, monitor_check_error='', updated_at=now() WHERE id=$1`,
      [campaignId]
    );
  }

  async recordMonitorCheckCompleted(campaignId, { newlyAccepted = 0, error = '' } = {}) {
    await this.pg.query(
      `UPDATE campaigns SET monitor_check_completed_at=now(), monitor_check_newly_accepted=$2,
         monitor_check_error=$3, updated_at=now() WHERE id=$1`,
      [campaignId, Math.max(0, Number(newlyAccepted) || 0), String(error || '')]
    );
  }

  // Bounded, ephemeral per-campaign monitor event log (Redis list). A check sweep
  // appends one line as it STARTS on each account, so the app's Live Status shows
  // every account it checks — reliably, unlike the app polling the live-browser
  // flag every 5s (which misses fast per-account checks, especially an all-senders
  // sweep across many accounts). Newest-first; capped + TTL'd because it's a
  // transient live feed, not a source of truth. No-op if line is empty.
  async appendMonitorLog(campaignId, line) {
    if (!line) return;
    const key = `cmp:monitorlog:${campaignId}`;
    try {
      await this.redis.lpush(key, JSON.stringify({ t: Date.now(), line: String(line) }));
      await this.redis.ltrim(key, 0, 49);          // keep the 50 most-recent
      await this.redis.expire(key, 7 * 24 * 3600);  // 7d TTL, matches monitoring window
    } catch (_) { /* best-effort — a log write must never break the sweep */ }
  }
  async getMonitorLog(campaignId, limit = 50) {
    const key = `cmp:monitorlog:${campaignId}`;
    try {
      const rows = await this.redis.lrange(key, 0, Math.max(0, limit - 1));
      return rows.map((r) => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
  }

  // ─── R4: automatic reply detection (mirrors post-campaign-reply-check.js) ─────
  // Voyager watermark for one (campaign, account). 0 when never scanned. The
  // reply sweep treats conversations with lastActivityAt > watermark as new.
  async getReplyWatermark(campaignId, account) {
    const { rows } = await this.pg.query(
      `SELECT watermark FROM campaign_reply_state WHERE campaign_id=$1 AND account=$2`,
      [campaignId, account]
    );
    return rows[0] ? Number(rows[0].watermark) : 0;
  }
  // Advance the watermark. GREATEST guards a REGRESSION — a slow sweep whose
  // startTime predates a faster concurrent one must never rewind the watermark
  // (which would re-surface already-recorded replies). Only ever moves forward.
  async setReplyWatermark(campaignId, account, watermark) {
    const wm = Math.trunc(Number(watermark) || 0);
    await this.pg.query(
      `INSERT INTO campaign_reply_state (campaign_id, account, watermark, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (campaign_id, account) DO UPDATE SET
         watermark=GREATEST(campaign_reply_state.watermark, EXCLUDED.watermark),
         updated_at=now()`,
      [campaignId, account, wm]
    );
  }
  // The campaign's leads THIS account messaged (assigned_profile = account) —
  // the candidateRows the app pre-filters to "Account Used = profileId" before
  // matching conversations. Shaped for matchConversationToSheet (firstName/
  // lastName) and checkProfileDms's linkedinUrl read (match.match['Linkedin URL']
  // || match.match[linkedinColumn]).
  async getReplyCandidateLeads(campaignId, account) {
    const { rows } = await this.pg.query(
      `SELECT id, lead_url, first_name, last_name FROM leads
       WHERE campaign_id=$1 AND assigned_profile=$2`,
      [campaignId, account]
    );
    return rows.map((r) => ({
      id: r.id,
      lead_url: r.lead_url,
      "Linkedin URL": r.lead_url,
      firstName: r.first_name || "",
      lastName: r.last_name || "",
    }));
  }
  // Accepted-but-not-yet-introduced leads for one account — the intro BACKLOG.
  // A check sweep introduces these (not only the ones NEWLY accepted this sweep),
  // so a connection accepted in an EARLIER sweep that never got introduced (intro
  // failed / was missed / accepted before intros were wired) is finally picked up.
  // "Accepted" = connection_accepted_status is Connected / Already connected;
  // "intro slot open" = blank OR the reconnect-retry sentinel — mirrors
  // isIntroSlotOpen() in campaign-lib/linkedin/intro-constants.js exactly, so the
  // SQL pre-filter and runAutoIntros' per-lead guard agree. Returns lead URLs; the
  // caller unions these with the sweep's newly-accepted URLs and hands them to
  // runAutoIntros, which re-checks each lead's slot and skips any already stamped.
  async getAcceptedPendingIntros(campaignId, account) {
    const { rows } = await this.pg.query(
      `SELECT lead_url FROM leads
        WHERE campaign_id=$1 AND assigned_profile=$2
          AND lower(btrim(connection_accepted_status)) IN ('connected','already connected')
          AND ( introduction_status IS NULL
                OR btrim(introduction_status) = ''
                OR btrim(introduction_status) = 'Reconnecting to primary — will retry' )
          AND lead_url IS NOT NULL AND btrim(lead_url) <> ''
        ORDER BY id`,
      [campaignId, account]
    );
    return rows.map((r) => r.lead_url);
  }
  // Local-check write-back: the operator ran an acceptance check for this cloud
  // campaign ON THEIR OWN MACHINE (the app's local GoLogin sweep, which stamps
  // results into the Google Sheet). Mirror those stamps into the engine's leads
  // so the VM's next sweep doesn't re-detect the acceptance and re-send the
  // intro (double-message). FILL-ONLY semantics: a field is written only when
  // the engine's value is blank (or, for intros, the reconnect-retry sentinel)
  // — the engine's own recorded outcomes are never overwritten. Matched by
  // lead_url. Returns { matched } (leads that had at least one field applied).
  async syncLeadStatuses(campaignId, rows = []) {
    let matched = 0;
    for (const r of rows || []) {
      const url = String((r && r.leadUrl) || "").trim();
      if (!url) continue;
      const acc = String((r && r.connectionAcceptedStatus) || "").trim();
      const intro = String((r && r.introductionStatus) || "").trim();
      if (!acc && !intro) continue;
      const { rowCount } = await this.pg.query(
        `UPDATE leads SET
           connection_accepted_status = CASE
             WHEN $3 <> '' AND btrim(COALESCE(connection_accepted_status,'')) = ''
             THEN $3 ELSE connection_accepted_status END,
           introduction_status = CASE
             WHEN $4 <> '' AND ( btrim(COALESCE(introduction_status,'')) = ''
                                 OR btrim(introduction_status) = 'Reconnecting to primary — will retry' )
             THEN $4 ELSE introduction_status END
         WHERE campaign_id=$1 AND btrim(lead_url)=$2
           AND ( ($3 <> '' AND btrim(COALESCE(connection_accepted_status,'')) = '')
              OR ($4 <> '' AND ( btrim(COALESCE(introduction_status,'')) = ''
                                 OR btrim(introduction_status) = 'Reconnecting to primary — will retry' )) )`,
        [campaignId, url, acc, intro]
      );
      matched += rowCount;
    }
    return { matched };
  }
  // Non-destructive "already stamped?" probe — has THIS reply (by dedup key)
  // already been recorded? The reply sweep checks this BEFORE the tracking
  // write, and only records AFTER the write succeeds, so a failed sheet write
  // leaves the reply un-recorded → retried next sweep (mirrors the app, which
  // re-reads the sheet's empty Reply cell and retries). body_key = first 80
  // chars, same axis as recordReplies.
  async hasReply(campaignId, account, leadUrl, bodyKey) {
    const { rows } = await this.pg.query(
      `SELECT 1 FROM campaign_replies
       WHERE campaign_id=$1 AND account=$2 AND lead_url=$3 AND body_key=$4 LIMIT 1`,
      [campaignId, account, leadUrl || "", String(bodyKey || "").slice(0, 80)]
    );
    return rows.length > 0;
  }
  // Record inbound replies; the PK (campaign,account,lead_url,body_key) makes the
  // same reply seen on consecutive sweeps a no-op. Returns the count of genuinely
  // NEW rows — the reply sweep uses this as the non-destructive "already replied?"
  // signal in place of reading the sheet status back.
  async recordReplies(campaignId, account, replies) {
    if (!replies || !replies.length) return 0;
    let inserted = 0;
    for (const r of replies) {
      const bodyKey = String(r.body || "").slice(0, 80);
      const { rowCount } = await this.pg.query(
        `INSERT INTO campaign_replies (campaign_id, account, lead_url, body_key, direction, sender, body, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (campaign_id, account, lead_url, body_key) DO NOTHING`,
        [campaignId, account, r.leadUrl || "", bodyKey, r.direction || "", r.sender || "", String(r.body || ""), r.ts || ""]
      );
      inserted += rowCount;
    }
    return inserted;
  }

  // ── KEDA scale bridge ───────────────────────────────────────────────────────
  // KEDA can't reach Postgres cross-namespace, so the always-on FRONTEND mirrors
  // the active-campaign count into a Redis LIST that the campaign ScaledObject
  // watches (listName cmp:scaleactive, listLength 2). Rebuilt authoritatively from
  // Postgres each tick → drift-free (a crashed campaign can't leak a token). Counts
  // the SAME statuses the old postgresql trigger did (queued/running/monitoring) so
  // scaling behaviour is unchanged. Caller MUST skip on throw so a transient DB blip
  // never zeroes the list and scales running campaigns to zero mid-flight.
  async refreshScaleMetric() {
    const { rows } = await this.pg.query(
      `SELECT count(*)::int AS n FROM campaigns WHERE status IN ('queued','running','monitoring')`
    );
    const n = Math.max(0, Math.min(Number(rows[0] && rows[0].n) || 0, 64)); // cap ≫ max pods
    // Atomically force LLEN(cmp:scaleactive) == n (DEL, then RPUSH n tokens).
    await this.redis.eval(
      "redis.call('DEL', KEYS[1]); local n=tonumber(ARGV[1]); if n>0 then local t={}; for i=1,n do t[i]='1' end; redis.call('RPUSH', KEYS[1], unpack(t)) end; return n",
      1, "cmp:scaleactive", String(n)
    );
    return n;
  }

  async close() {
    try { await this.pg.end(); } catch {}
  }
}

module.exports = { CampaignStore, ACCT_LOCK_PREFIX, connMatchKey };
