// campaign-sheet-writer.js
//
// Sheet write-back for cloud campaigns. The engine's system of record is
// Postgres, but operators read results in their Google Sheet — so after a lead
// is actioned we push its status columns back to the Sheet, IDENTICALLY to how
// the desktop app does it: a POST to the operator's Apps Script web app
// (action:'updateRow'), which matches the row by LinkedIn URL and writes the
// tracking columns. The app passes its SHEETS_WEBAPP_URL + linkedinColumn in the
// campaign config, so the write path is byte-for-byte the same as local runs.
//
// Decoupled from the action path: the runtime calls syncCampaignSheet() on its
// own cadence, reading dirty leads from Postgres and pushing them. A failed
// write leaves sheet_dirty=true → retried next sweep. Nothing here ever throws
// into the campaign flow.

// Google Sheet URL → spreadsheet id + tab gid (mirrors app src/utils.js).
function extractSheetId(url) {
  const m = String(url || "").match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : "";
}
function extractSheetGid(url) {
  const m = String(url || "").match(/[#&?]gid=(\d+)/);
  return m ? m[1] : "";
}

// Postgres stores booleans as real `true`/`false`, but a value coming back
// through JSONB or a raw row can be the strings "t"/"true". Normalize both.
function isTrue(v) {
  return v === true || v === "t" || v === "true" || v === 1 || v === "1";
}

// R4 #14 audit verb: the engine reconstructs write-back from stored columns, not
// from an action result, so derive the audit action from the lead's terminal
// state using the app's canonical strings (buildSheetDataForAction). Ordered
// most-terminal first so a lead re-dirtied by a later phase (e.g. acceptance
// after connect) logs the newest verb, not the original one.
function deriveAuditAction(lead) {
  // A "Skipped: …" request status (e.g. Email required) is a skip, not a send —
  // without this guard the CRS-non-empty fallback below logged "Connection sent".
  if (String(lead.connection_request_status || "").trim().startsWith("Skipped:")) return "Skipped";
  const cc = String(lead.connection_accepted_status || "").toLowerCase();
  if (cc.startsWith("connected")) return "Acceptance confirmed";
  if (isTrue(lead.connected_already)) return "Already 1st-degree connection";
  if (String(lead.introduction_status || "").trim() || lead.stage === "IC") return "Introduction sent";
  if (String(lead.dm_status || "").trim() || lead.stage === "DM") return "Message sent";
  if (lead.stage === "InMail") return "InMail sent";
  if (lead.stage === "OP Msg") return "Open Profile message sent";
  if (String(lead.connection_request_status || "").trim() || lead.stage === "CC") return "Connection sent";
  return "";
}

// The engine tracks a lead's stage as a terse internal CODE ("CC", "IC", "DM",
// "InMail", "OP Msg", "Already connected", "already_processed", "dup"). The
// desktop app writes the SAME column in full English ("Connect Pending", "IC
// Sent", …) — so a cloud sheet showed cryptic codes the app reconciler only
// later overwrote, leaving a window where the operator saw "CC" next to
// "Connected · DM Now". Translate the code → the app's EXACT Stage wording at the
// write boundary so the sheet reads 1:1 with a local run from the very first
// stamp. Sourced verbatim from the app's buildSheetDataForAction (src/campaign.js).
// Codes NOT listed (e.g. 'Connected', 'Connected · DM Now', 'Skipped: …') are
// already the app's own wording → passed through. Only the SHEET value is mapped;
// lead.stage itself is untouched, so the internal derivations below (and
// deriveAuditAction) keep matching on the raw codes.
//
// `already_processed` (a real vendored-outreach outcome: the connect/DM/InMail is
// already in flight) is MODE-DEPENDENT — the app stamps the same Stage it would
// for a fresh send in that mode — so it needs the campaign mode.
function alreadyProcessedStage(mode) {
  switch (String(mode || "")) {
    case "message_only":      return "DM Sent";
    case "introduce_back":    return "IC Sent";
    case "inmail_only":       return "InM Sent";
    case "open_profile_only": return "OP Sent";
    // connect_only / connect_and_introduce / connect_and_message (+ default):
    // the app's already_processed branch stamps 'Connect Pending'.
    default:                  return "Connect Pending";
  }
}
function stageLabel(code, mode) {
  switch (String(code || "")) {
    case "CC":                return "Connect Pending";
    case "Still Pending":     return "Connect Pending"; // app leaves Stage on the connect wording while a check is pending
    case "IC":                return "IC Sent";
    case "DM":                return "DM Sent";
    case "InMail":            return "InM Sent";
    case "OP Msg":            return "OP Sent";
    case "Already connected": return "Connected";
    case "already_processed": return alreadyProcessedStage(mode);
    case "dup":               return "Skipped: Duplicate"; // anti-dupe re-encounter; the app dedups before writing, so surface a readable skip, never the raw code
    default:                  return code;                 // already the app's wording (Connected, Skipped: …)
  }
}

// Engine lead row → the Apps Script FIELD_MAP KEYS (NOT column display names —
// the script maps keys like `connectionStatus` to 'Connection Request Status').
// Only non-empty values are written. `cfg` is the campaign config (for the
// accountEmails profileId→email map used to render the Sender/Account Used label).
function buildTracking(lead, cfg = {}, mode = "") {
  const t = {};
  const put = (key, val) => { if (val != null && String(val).trim() !== "") t[key] = String(val); };
  // Explicit status fields (monitored modes populate these in Postgres).
  put("connectionStatus", lead.connection_request_status);   // → Connection Request Status
  put("checkStatus", lead.connection_accepted_status);        // → Connection Accepted Status
  put("introductionStatus", lead.introduction_status);        // → Introduction Status
  put("dmStatus", lead.dm_status);                            // → DM Status
  put("stage", stageLabel(lead.stage, mode));                 // → Stage (app's English wording, 1:1 with local)
  // One-shot SEND modes stamp only `stage` (connect_only leaves the explicit
  // status blank). Derive the matching status field from the stage so it lands
  // in the sheet's per-mode column — this was the connect_only write-back miss.
  if (!t.connectionStatus && lead.stage === "CC") t.connectionStatus = "Connection Request Sent";
  if (!t.dmStatus && lead.stage === "DM") t.dmStatus = "DM Sent";
  if (!t.introductionStatus && lead.stage === "IC") t.introductionStatus = "Introduction Made";
  if (lead.stage === "InMail") put("inmStatus", "InMail Sent");
  if (lead.stage === "OP Msg") put("opStatus", "Message Sent");

  // R4 #14 — Sender / Account Used. The operator reads WHICH account actioned
  // each lead from these columns; the VM left them blank, which also broke the
  // Check-DMs candidate filter (keys on a non-empty Sender) and suppressed the
  // Apps Script audit log (fires only when accountUsed is present). assigned_
  // profile is the GoLogin profile id — map it to the operator-visible email
  // (cfg.accountEmails: profileId→email), falling back to route_account (the
  // sheet's original Account-Used, for auto-routed modes) then the raw id.
  // Written to BOTH keys, mirroring app buildSheetDataForAction (Sender = v2
  // schema, Account Used = legacy column; sheets with only one ignore the other).
  const emails = cfg.accountEmails || {};
  const account = lead.assigned_profile || lead.route_account || "";
  const senderLabel = emails[account] || lead.route_account || account || "";
  if (senderLabel) { t.sender = senderLabel; t.accountUsed = senderLabel; }

  // R4 #14 — stable identity columns (revive the num:/urn: match axes on
  // re-import + show the operator the person's ids). member_urn = LinkedIn URN,
  // member_number = numeric Membership ID.
  put("linkedinUrn", lead.member_urn);
  put("linkedinMemberId", lead.member_number);

  // R4 #14 — Connected column: 'Yes' for a 1st-degree connection (already-
  // connected at send time, or acceptance-confirmed during monitoring). Mirrors
  // app connectedAlready ('Yes' only; never stamps 'No' — leaves the cell blank).
  if (isTrue(lead.connected_already) || String(lead.connection_accepted_status || "").toLowerCase().startsWith("connected")) {
    t.connectedAlready = "Yes";
  }

  // Timestamp — the Apps Script splits this into Date/Time of Last Action,
  // stamping the EXACT action moment (updated GAS uses this ISO value when it's a
  // valid date; older GAS ignores it and stamps write-time). date_last_action is
  // set by monitor-phase outcome updates (acceptance/intro); one-shot SENDS leave
  // it null, so fall back to sent_at — stamped at the send moment in markLead — so
  // "Date/Time of Last Action" reflects when we actually sent, 1:1 with local.
  const actionTs = lead.date_last_action || lead.sent_at;
  if (actionTs) t.dateLastAction = new Date(actionTs).toISOString();
  // tz → GAS formats the timestamp in the operator's chosen timezone (the app
  // passes cfg.tz at cloud start; absent for pre-fix campaigns → GAS script tz).
  if (cfg.tz) t.tz = String(cfg.tz);

  // R4 #19 — audit log. The Apps Script appends an Audit Log entry whenever
  // accountUsed is present (action = auditAction || status). Provide the verb so
  // the entry is meaningful instead of blank. Only when we actually have a
  // sender (no account → not a real action → no audit).
  if (t.accountUsed) {
    const verb = deriveAuditAction(lead);
    if (verb) t.auditAction = verb;
  }
  return t;
}

// A transient write error is a network/timeout/5xx-class failure a retry can
// plausibly fix — as opposed to a permanent one (auth, row-not-found, bad
// request) where retrying just wastes time. Mirrors the app's
// sheets-writer.isTransientWriteError. updateRow is idempotent (sets fixed cell
// values), so retrying a transient failure is safe.
const _TRANSIENT_WRITE_RE =
  /timeout|abort|ECONN|EAI_AGAIN|socket|network|fetch failed|terminated|\b(429|500|502|503|504)\b/i;
function isTransientWriteError(msg) {
  return _TRANSIENT_WRITE_RE.test(String(msg || ""));
}

// Per-leg timeout on the Apps Script POST + its 302-redirect follow. Raised from
// 15s → 30s because the operator's webapp cold-starts (measured 2s warm, but
// 28–58s cold); a single 15s attempt aborts EVERY write while it's cold, which
// is why cloud write-back silently wrote nothing. 30s + retry absorbs it: even
// if attempt 1 aborts, it has warmed the instance so the retry lands in ~2s.
const WEBAPP_TIMEOUT_MS = 30000;

// One updateRow POST to the operator's web app. Mirrors sheets-writer.js:
// follows the Apps Script 302 redirect, never throws (returns {ok}|{error}).
async function pushRowOnce(webappUrl, sheetUrl, linkedinUrl, tracking, linkedinColumn) {
  // EXACT payload the app's sheets-writer.updateSheetRow sends: sheetId+gid
  // (not sheetUrl), urlColumnName (not linkedinColumn), and the tracking columns
  // SPREAD at the top level (not nested). The Apps Script rejects anything else
  // ("sheetId is required").
  const payload = JSON.stringify({
    action: "updateRow",
    sheetId: extractSheetId(sheetUrl),
    gid: extractSheetGid(sheetUrl) || "",
    linkedinUrl,
    urlColumnName: linkedinColumn || "",
    ...tracking,
  });
  try {
    const initial = await fetch(webappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get("location");
      if (location) res = await fetch(location, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    }
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed.error) return { error: parsed.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// Retry the idempotent updateRow across transient failures (the app's local
// path does the same via withWriteRetry — it's what makes local write-back
// survive the webapp's cold-start latency where cloud previously didn't).
// Permanent errors (auth, row-not-found) return immediately. `sleep` injectable
// for tests. Default 4 attempts, linear backoff (1.5s × attempt).
async function pushRow(webappUrl, sheetUrl, linkedinUrl, tracking, linkedinColumn, {
  maxAttempts = 4,
  baseDelayMs = 1500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!webappUrl || !linkedinUrl || !Object.keys(tracking).length) return { ok: true, skipped: true };
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await pushRowOnce(webappUrl, sheetUrl, linkedinUrl, tracking, linkedinColumn);
    if (!result || !result.error) return result;              // success
    if (!isTransientWriteError(result.error)) return result;  // permanent — don't retry
    if (attempt < maxAttempts) await sleep(baseDelayMs * attempt);
  }
  return result; // exhausted retries — return last (transient) error; lead stays dirty for next sweep
}

// R4 — append one inbound reply to the sheet's Replies tab. Mirrors the app's
// sheets-writer.appendReplyRow (POST action:'appendReply'; the Apps Script bridge
// dedupes on (leadUrl, body)) with the engine's redirect-following POST style
// (pushRowOnce / prepareSheet). Never throws; returns {ok}|{error}. A missing
// webapp/leadUrl/body is a benign skip ({ok:true, skipped:true}) — same guard the
// app applies (leadUrl + body required).
async function appendReply(webappUrl, sheetUrl, reply) {
  if (!webappUrl || !reply || !reply.leadUrl || !reply.body) return { ok: true, skipped: true };
  const payload = JSON.stringify({
    action: "appendReply",
    sheetId: extractSheetId(sheetUrl),
    gid: extractSheetGid(sheetUrl) || "",
    leadUrl: reply.leadUrl,
    timestamp: reply.timestamp || "",
    firstName: reply.firstName || "",
    lastName: reply.lastName || "",
    body: reply.body || "",
  });
  try {
    const initial = await fetch(webappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get("location");
      if (location) res = await fetch(location, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    }
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed.error) return { error: parsed.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// R4 #4 — provision the mode's tracking columns on the sheet BEFORE any write-
// back. The Apps Script silently skips writes to columns that don't exist
// (`if (colIndex === -1) continue`), so without this a fresh sheet drops every
// stamp for a column it lacks (e.g. an absent 'Introduction Status'). Mirrors
// the app's sheets-writer.prepareSheet: POST {action:'prepareSheet', sheetId,
// gid, mode}; the script adds this mode's columns + hides other modes'. Follows
// the 302 redirect like every other webapp call. Best-effort — never throws;
// returns {ok, added?, hidden?, shown?} | {error}. Idempotent (safe to re-run).
async function prepareSheet(webappUrl, sheetUrl, mode) {
  if (!webappUrl || !sheetUrl || !mode) return { ok: false, skipped: true };
  const payload = JSON.stringify({
    action: "prepareSheet",
    sheetId: extractSheetId(sheetUrl),
    gid: extractSheetGid(sheetUrl) || "",
    mode,
  });
  try {
    const initial = await fetch(webappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get("location");
      if (location) res = await fetch(location, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    }
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed.error) return { error: parsed.error || `HTTP ${res.status}` };
    // App script returns {success:true, added, hidden, shown}; normalize to ok.
    return { ok: parsed.success !== false, added: parsed.added || [], hidden: parsed.hidden || [], shown: parsed.shown || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// Push all of a campaign's dirty leads to its Sheet, then clear their flags.
// Reads webappUrl + linkedinColumn from campaign.config (passed by the app).
// Injectable `push` for tests. Returns { pushed, failed, skipped }.
async function syncCampaignSheet({ store, campaign, push, log = () => {}, limit = 200 }) {
  const result = { pushed: 0, failed: 0, skipped: 0 };
  const cfg = campaign.config || {};
  const webappUrl = cfg.sheetsWebappUrl || cfg.sheetWebappUrl || "";
  const sheetUrl = campaign.sheet_url || cfg.sheetUrl || "";
  const linkedinColumn = cfg.linkedinColumn || "LinkedIn URL";
  // No Sheet configured → nothing to write back (Postgres stays the record).
  if (!webappUrl || !sheetUrl) return result;

  const dirty = await store.getLeadsNeedingSheetSync(campaign.id, limit);
  if (!dirty.length) return result;

  const _push = push || pushRow;
  const synced = [];
  for (const lead of dirty) {
    const tracking = buildTracking(lead, cfg, campaign.mode);
    if (!Object.keys(tracking).length) { synced.push(lead.id); result.skipped++; continue; }
    const r = await _push(webappUrl, sheetUrl, lead.lead_url, tracking, linkedinColumn);
    if (r && r.error) { result.failed++; continue; } // leave dirty → retried next sweep
    synced.push(lead.id);
    result.pushed++;
  }
  if (synced.length) await store.markLeadsSheetSynced(synced);
  if (result.pushed || result.failed) log(`[sheet] ${campaign.id}: pushed ${result.pushed}, failed ${result.failed}`);
  return result;
}

// R4 #3 — dump the sweep's inbound 1:1 replies to the "Recent Messages" sidecar
// tab (mirrors app sheets-writer.writeRecentMessagesTab: POST
// action:'writeRecentMessages' with {sheetId, sender, messages, activeSenders}).
// The Apps Script owns the fixed-name tab (no gid). Never throws; returns
// {ok}|{error}. Empty messages is a benign skip.
async function writeRecentMessages(webappUrl, sheetUrl, sender, messages) {
  if (!webappUrl || !Array.isArray(messages) || messages.length === 0) return { ok: true, skipped: true };
  const payload = JSON.stringify({
    action: "writeRecentMessages",
    sheetId: extractSheetId(sheetUrl),
    sender: sender || "",
    messages,
    activeSenders: [],
  });
  try {
    const initial = await fetch(webappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get("location");
      if (location) res = await fetch(location, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    }
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed.error) return { error: parsed.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { syncCampaignSheet, buildTracking, deriveAuditAction, stageLabel, prepareSheet, pushRow, pushRowOnce, appendReply, writeRecentMessages, isTransientWriteError };
