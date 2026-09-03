// campaign-live-registry.js
//
// In-process registry of OPEN campaign browser sessions on THIS worker pod,
// keyed by campaignId, plus a short-TTL Redis stamp so the always-on frontend
// can discover which pod holds a campaign's live browser (cross-pod View).
// Most-recently-registered account wins per campaign (spec: "most-recently-
// active"). All Redis writes are best-effort — a hiccup must never break a
// campaign or delay a reap.
const LIVE_KEY = (id) => `cmp:live:${id}`;

function makeLiveRegistry({ redis, podIP, podPort, ttlSec = 30 }) {
  const live = new Map(); // campaignId -> { account, page, startedAt }
  let hb = null;

  async function register(campaignId, account, page) {
    const startedAt = Date.now();
    live.set(campaignId, { account, page, startedAt });
    try {
      await redis.set(LIVE_KEY(campaignId),
        JSON.stringify({ podIP, podPort: String(podPort), account, startedAt }),
        "EX", ttlSec);
    } catch (_) { /* best-effort */ }
  }

  async function unregister(campaignId, account) {
    const cur = live.get(campaignId);
    if (!cur || cur.account !== account) return; // a newer session owns it now
    live.delete(campaignId);
    try { await redis.del(LIVE_KEY(campaignId)); } catch (_) { /* best-effort */ }
  }

  // Merge a live per-person PROGRESS patch into this campaign's stamp, so the
  // frontend can surface "selecting N/total on <account>" during a batch send.
  // Re-stamps the SAME key (refreshing TTL); no-ops if a newer account's session
  // now owns the campaign. All best-effort — progress is cosmetic.
  async function progress(campaignId, account, patch) {
    const cur = live.get(campaignId);
    if (!cur || cur.account !== account) return; // a newer session owns it now
    cur.progress = patch || null;
    live.set(campaignId, cur);
    try {
      await redis.set(LIVE_KEY(campaignId),
        JSON.stringify({ podIP, podPort: String(podPort), account, startedAt: cur.startedAt, progress: cur.progress }),
        "EX", ttlSec);
    } catch (_) { /* best-effort */ }
  }

  function get(campaignId) { return live.get(campaignId) || null; }

  function startHeartbeat(intervalMs = 10000) {
    if (hb) return;
    hb = setInterval(() => {
      for (const id of live.keys()) redis.expire(LIVE_KEY(id), ttlSec).catch(() => {});
    }, intervalMs);
    if (hb.unref) hb.unref();
  }
  function stopHeartbeat() { if (hb) { clearInterval(hb); hb = null; } }

  return { register, unregister, progress, get, startHeartbeat, stopHeartbeat };
}

module.exports = { makeLiveRegistry, LIVE_KEY };
