// campaign-soo-writer.js
//
// SoO (State of Operations) write-back for cloud campaigns — Blocker 4. When a
// cloud campaign hits a dead LinkedIn session, the engine flags the account
// "Needs Login: Y" in the shared SoO sheet, IDENTICALLY to the local app
// (src/soo-writer.markAccountNeedsLoginSoO): a setSoO POST to the same Apps
// Script web app, targeting the SoO sheet (sooSheetId/gid), matched by the
// account's LinkedIn email.
//
// The engine only knows GoLogin profileIds, so the app passes an email map
// (config.accountEmails: { profileId -> email }) + the SoO sheet id/gid. If
// any piece is missing the write is a graceful no-op. Never throws.
//
// COLD-START RETRY (pairs with the sheet-writeback fix): this hits the SAME Apps
// Script web-app as campaign-sheet-writer, which cold-starts in 28–58s. A single
// 15s attempt aborts every stamp while the webapp is cold — the exact reason the
// Needs-Login flag landed unreliably. So we mirror the sheet-writer: 30s per-leg
// timeout + transient-only retry (setSoO is idempotent — it sets a fixed cell —
// so retrying a transient failure is safe). The transient-error classifier is
// kept LOCAL (not imported from campaign-sheet-writer) so this file applies in
// any order and can't half-break; keep the regex in sync with that writer's copy.

// Same 30s per-leg timeout as the sheet-writer (absorbs the webapp cold-start).
const WEBAPP_TIMEOUT_MS = 30000;

// A transient write error is a network/timeout/5xx-class failure a retry can fix
// (vs. a permanent one — auth, bad request — where retrying just wastes time).
// Mirror of campaign-sheet-writer.isTransientWriteError; keep the two in sync.
const _TRANSIENT_WRITE_RE =
  /timeout|abort|ECONN|EAI_AGAIN|socket|network|fetch failed|terminated|\b(429|500|502|503|504)\b/i;
function isTransientWriteError(msg) {
  return _TRANSIENT_WRITE_RE.test(String(msg || ""));
}

// One attempt at the setSoO POST (+ its 302-redirect follow). Returns
// { ok:true } | { ok:false, error } | { ok:false, skipped:true }. Never throws.
async function markNeedsLoginOnce({ webappUrl, sooSheetId, sooGid, email }) {
  if (!webappUrl || !sooSheetId || !email) return { ok: false, skipped: true };
  const payload = JSON.stringify({
    sheetId: sooSheetId,
    gid: sooGid || "",
    action: "setSoO",
    email,
    fields: { "Needs Login": "Y" },
    guardAvailableFor: [], // no guard — always stamp
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
      const loc = initial.headers.get("location");
      if (loc) res = await fetch(loc, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    }
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed.error) return { ok: false, error: parsed.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Retry the idempotent setSoO across transient failures — mirrors
// campaign-sheet-writer.pushRow so the Needs-Login stamp survives the webapp's
// cold-start latency where a single attempt previously aborted. Permanent errors
// (auth, bad request) return immediately. `sleep` is injectable for tests.
// Default 4 attempts, linear backoff (1.5s × attempt). Never throws.
async function markNeedsLogin(opts, {
  maxAttempts = 4,
  baseDelayMs = 1500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await markNeedsLoginOnce(opts);
    if (!result || !result.error) return result;             // success or graceful skip
    if (!isTransientWriteError(result.error)) return result; // permanent — don't retry
    if (attempt < maxAttempts) await sleep(baseDelayMs * attempt);
  }
  return result; // exhausted retries — return last (transient) error
}

module.exports = { markNeedsLogin, markNeedsLoginOnce };
