// Real pg + redis. Run:
// PG_URL=postgres://postgres:dev@localhost:5433/campaigns REDIS_URL=redis://localhost:6379 node test-local-followups-store.js
const assert = require('node:assert');
const Redis = require('ioredis');
const { CampaignStore } = require('./campaign-store.js');

(async () => {
  const store = new CampaignStore({ pgUrl: process.env.PG_URL, redis: new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }), podId: 'lf' });
  const owner = 'owner-test@ortus.test';
  const other = 'other@ortus.test';
  // Purge any rows left by a prior failed run (method is owner-scoped across all
  // that owner's campaigns, so orphans would inflate the counts).
  await store.pg.query("DELETE FROM campaign_tasks WHERE campaign_id IN (SELECT id FROM campaigns WHERE owner = ANY($1))", [[owner, other]]);
  await store.pg.query("DELETE FROM campaigns WHERE owner = ANY($1)", [[owner, other]]);
  const cid = 'cmp_lf_' + (process.hrtime.bigint() % 1000000n).toString();
  await store.pg.query(
    "INSERT INTO campaigns(id,name,mode,status,owner,profile_ids,daily_limit,sheet_url,config) VALUES ($1,'','connect_and_introduce','monitoring',$2,'{}',10,'https://sheet/x','{}')",
    [cid, owner]);

  const mk = (sender, lead, due) => store.createTask({
    campaignId: cid, type: 'follow_up', dedupeKey: `fu:${sender}:${lead}`,
    dueAt: due, payload: { sender, leadUrl: lead, threadUrl: 't', body: 'b', profileId: 'acc1' },
  });
  const past = new Date(Date.now() - 60000), future = new Date(Date.now() + 3600000);
  await mk('local-browser', 'https://lk/in/a', past);   // due personal → should be pulled + NOT claimed
  await mk('local-browser', 'https://lk/in/b', future);  // future personal → not due
  await mk('gologinProfile1', 'https://lk/in/c', past);  // gologin → claimable, not pulled

  // claimNextDueTask must skip the personal one and hand back the gologin one.
  const claimed = await store.claimNextDueTask();
  assert.ok(claimed && claimed.payload.sender === 'gologinProfile1', 'claims gologin, skips personal');
  assert.strictEqual(await store.claimNextDueTask(), null, 'no more claimable (personal is skipped)');

  // getPendingLocalFollowups: owner-scoped, due-only, personal-only.
  const pend = await store.getPendingLocalFollowups(owner);
  assert.strictEqual(pend.length, 1, 'one due personal follow-up for owner');
  assert.strictEqual(pend[0].payload.leadUrl, 'https://lk/in/a');
  assert.strictEqual(pend[0].sheetUrl, 'https://sheet/x');
  assert.strictEqual((await store.getPendingLocalFollowups(other)).length, 0, 'other owner sees none');

  // delegate: wrong owner delegates nothing; correct owner → 1, drops out of pending.
  assert.strictEqual((await store.delegateLocalFollowups([pend[0].taskId], other)).delegated, 0, 'wrong owner delegates nothing');
  const del = await store.delegateLocalFollowups([pend[0].taskId], owner);
  assert.strictEqual(del.delegated, 1);
  assert.strictEqual((await store.getPendingLocalFollowups(owner)).length, 0, 'delegated drops out of pending');

  await store.pg.query('DELETE FROM campaign_tasks WHERE campaign_id=$1', [cid]);
  await store.pg.query('DELETE FROM campaigns WHERE id=$1', [cid]);
  await store.close();
  console.log('OK test-local-followups-store');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
