// One-off: reset personal (local-browser) follow_up tasks stranded by the old VM
// replay path (status error/claimed) back to pending so the owner's app drains
// them via the local runner. Safe to re-run — local send dedupes.
// Run: PG_URL=... REDIS_URL=... node migrate-reset-local-followups.js
const Redis = require('ioredis');
const { CampaignStore } = require('./campaign-store.js');
(async () => {
  const store = new CampaignStore({ pgUrl: process.env.PG_URL, redis: new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }), podId: 'migrate' });
  const { rowCount } = await store.pg.query(
    `UPDATE campaign_tasks SET status='pending', claimed_by=NULL, claimed_at=NULL
      WHERE type='follow_up' AND payload->>'sender'='local-browser'
        AND status IN ('error','claimed')`
  );
  console.log('reset personal follow-ups →', rowCount);
  await store.close(); store.redis.disconnect(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
