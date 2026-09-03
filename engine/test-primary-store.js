// test-primary-store.js
//
// campaign_primaries registry — the store accessors used to persist a PRIMARY
// LinkedIn account's session cookies so a follow-up can later be sent as them
// on the VM.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-primary-store.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => {
    await admin.pg.query("TRUNCATE campaign_primaries");
  };
  await wipe();

  // ── upsert then read back by member ──
  const cookies = [{ name: "li_at", value: "abc123" }];
  const row = await admin.upsertPrimarySession({
    memberId: "m1", publicIdentifier: "Jane-Doe", displayName: "Jane Doe", cookies,
  });
  assert(row && row.member_id === "m1", "upsertPrimarySession returns the row");
  assert(row.state === "live", "new primary defaults to state=live");

  const byMember = await admin.getPrimaryByMember("m1");
  assert(byMember && byMember.display_name === "Jane Doe", "getPrimaryByMember reads it back");
  assert(JSON.stringify(byMember.cookies) === JSON.stringify(cookies), "cookies round-trip through jsonb");

  assert((await admin.getPrimaryByMember("nope")) === null, "getPrimaryByMember returns null for unknown member");

  // ── read back by slug, mixed-case proves case-insensitive ──
  const bySlug = await admin.getPrimaryBySlug("jane-doe");
  assert(bySlug && bySlug.member_id === "m1", "getPrimaryBySlug matches case-insensitively (lowercase query)");
  const bySlugUpper = await admin.getPrimaryBySlug("JANE-DOE");
  assert(bySlugUpper && bySlugUpper.member_id === "m1", "getPrimaryBySlug matches case-insensitively (uppercase query)");
  assert((await admin.getPrimaryBySlug("nobody-here")) === null, "getPrimaryBySlug returns null for unknown slug");

  // ── upsert on conflict updates in place, no duplicate row ──
  const updated = await admin.upsertPrimarySession({
    memberId: "m1", publicIdentifier: "jane-doe-2", displayName: "Jane D.", cookies: [{ name: "li_at", value: "zzz" }],
  });
  assert(updated.public_identifier === "jane-doe-2", "re-upsert on same member_id updates fields");
  const { rows: allRows } = await admin.pg.query("SELECT * FROM campaign_primaries WHERE member_id=$1", ["m1"]);
  assert(allRows.length === 1, "ON CONFLICT(member_id) does not create a duplicate row");

  // ── setPrimaryState flips live -> needs_login ──
  await admin.setPrimaryState("m1", "needs_login");
  const flipped = await admin.getPrimaryByMember("m1");
  assert(flipped.state === "needs_login", "setPrimaryState flips live -> needs_login");

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — campaign_primaries registry is correct"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
