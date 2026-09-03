// test-r3-bulkcheck-whole-campaign.js
//
// R3 parity: the acceptance bulk-check must run against the WHOLE campaign
// (every account's leads + every account's accumulated connections), exactly
// like the local app's whole-sheet pass — not partitioned to the sweeping
// account. Drives the REAL runBulkCheck + REAL matcher (campaign-bulkcheck-
// core.mjs is pure) through a fake in-memory store, so no PG/Redis/browser.
//
//   #11 — cross-account acceptance detection: account A's sweep resolves a row
//         whose Sender is B when A is the one actually connected (reassign +
//         "Already Connected"), then fires the intro from A on the next sweep.
//   #12 — urn-only / memberNumber-only connections are kept (connMatchKey) and
//         still match a lead by member id.
//   #15 — whole-campaign dedup: the same person on two rows under different
//         senders is resolved together and introduced ONCE.
//
// Run: node test-r3-bulkcheck-whole-campaign.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runBulkCheck, mapUpdate } = require("./campaign-monitor.js");
const { connMatchKey } = require("./campaign-conn-identity.js");

const ACCT_A = "eryca@ortus.solutions";
const ACCT_B = "carmella@ortus.solutions";

// In-memory store mirroring the real one's connection dedup (connMatchKey) and
// lead-outcome writes. getAllConnections returns EVERY account's conns tagged
// with `account` — the shape the matcher's cross-account branch reads.
class FakeStore {
  constructor(leads) {
    this._leads = leads.map((l) => ({ ...l }));
    this._conns = []; // { account, publicId, urn, memberNumber, firstName, lastName }
  }
  async upsertConnections(_campaignId, account, fresh) {
    for (const c of fresh || []) {
      const mk = connMatchKey(c);
      if (!mk) continue; // truly keyless — dropped (matches real store)
      const rec = {
        account,
        publicId: c.publicId || c.public_id || "",
        urn: c.urn || "",
        memberNumber: String(c.memberNumber || c.member_number || ""),
        firstName: c.firstName || c.first_name || "",
        lastName: c.lastName || c.last_name || "",
      };
      const dup = this._conns.find((x) => x.account === account && connMatchKey(x) === mk);
      if (dup) Object.assign(dup, rec);
      else this._conns.push(rec);
    }
  }
  async getAllConnections() { return this._conns.map((c) => ({ ...c })); }
  async getConnections(_c, account) { return this._conns.filter((c) => c.account === account).map((c) => ({ ...c })); }
  async getCampaignLeads() { return this._leads.map((l) => ({ ...l })); }
  async updateLeadOutcome(id, f) {
    const lead = this._leads.find((l) => l.id === id);
    if (!lead) return;
    if (f.connectionAcceptedStatus != null) lead.connection_accepted_status = f.connectionAcceptedStatus;
    if (f.connectionRequestStatus != null) lead.connection_request_status = f.connectionRequestStatus;
    if (f.introductionStatus != null) lead.introduction_status = f.introductionStatus;
    if (f.dmStatus != null) lead.dm_status = f.dmStatus;
    if (f.stage != null) lead.stage = f.stage;
    if (f.connectedAlready != null) lead.connected_already = f.connectedAlready;
    if (f.assignedProfile != null) lead.assigned_profile = f.assignedProfile;
  }
  lead(id) { return this._leads.find((l) => l.id === id); }
}

const lead = (o) => ({
  id: o.id,
  lead_url: o.url,
  assigned_profile: o.sender,
  first_name: o.first || "",
  last_name: o.last || "",
  connection_request_status: o.crs ?? "Connection Request Sent",
  connection_accepted_status: o.cas ?? "",
  introduction_status: o.intro ?? "",
  dm_status: o.dm ?? "",
  member_urn: o.urn ?? "",
  row_data: o.row_data ?? {},
});

const campaign = (mode = "connect_and_introduce") => ({ id: "cmp1", mode });
const sweep = (store, account, fresh) =>
  runBulkCheck({ store, campaign: campaign(), account, page: null, fetchRecent: async () => fresh });

// ── connMatchKey (#12 unit) ──────────────────────────────────────────────────
test("connMatchKey prefers publicId, falls back to urn then memberNumber", () => {
  assert.equal(connMatchKey({ publicId: "vito", urn: "ACoAAx", memberNumber: "9" }), "vito");
  assert.equal(connMatchKey({ urn: "ACoAAx", memberNumber: "9" }), "ACoAAx");
  assert.equal(connMatchKey({ memberNumber: "9" }), "9");
  assert.equal(connMatchKey({}), "");
});

// ── mapUpdate honors sender reassignment (#11) ───────────────────────────────
test("mapUpdate maps a non-empty sender to assignedProfile; blank is ignored", () => {
  assert.equal(mapUpdate({ sender: ACCT_A }).assignedProfile, ACCT_A);
  assert.equal("assignedProfile" in mapUpdate({ sender: "" }), false);
  assert.equal("assignedProfile" in mapUpdate({ cc: "Connected" }), false);
});

// ── #11 cross-account acceptance detection ───────────────────────────────────
test("#11 A's sweep resolves a B-owned row when A is the connected account", async () => {
  const store = new FakeStore([
    lead({ id: 1, url: "https://linkedin.com/in/vito", sender: ACCT_B, first: "Vito", last: "M" }),
    lead({ id: 2, url: "https://linkedin.com/in/anna", sender: ACCT_A, first: "Anna", last: "K" }),
  ]);
  // A sweeps; A is connected to Vito (whom B invited), not yet to Anna.
  const r1 = await sweep(store, ACCT_A, [
    { firstName: "Vito", lastName: "M", publicId: "vito", urn: "ACoAAvito", memberNumber: "500" },
  ]);
  // Vito's row reassigned to A + "Already Connected"; intro deferred (not queued).
  assert.equal(store.lead(1).assigned_profile, ACCT_A, "row reassigned to connected account");
  assert.match(store.lead(1).connection_accepted_status, /Already Connected/i);
  assert.equal(r1.connectedUrls.includes("https://linkedin.com/in/vito"), false,
    "cross-sender branch defers the intro to the reassigned account's own sweep");

  // Next sweep: now assigned to A and A connected → normal path fires the intro.
  const r2 = await sweep(store, ACCT_A, [
    { firstName: "Vito", lastName: "M", publicId: "vito", urn: "ACoAAvito", memberNumber: "500" },
  ]);
  assert.equal(r2.connectedUrls.includes("https://linkedin.com/in/vito"), true,
    "reassigned account's sweep now queues the intro");
});

// ── #15 whole-campaign dedup across senders ──────────────────────────────────
test("#15 same person on two rows under different senders is introduced once", async () => {
  const store = new FakeStore([
    lead({ id: 1, url: "https://linkedin.com/in/vito", sender: ACCT_A, first: "Vito", last: "M" }),
    lead({ id: 2, url: "https://linkedin.com/in/vito", sender: ACCT_B, first: "Vito", last: "M" }),
  ]);
  const r = await sweep(store, ACCT_A, [
    { firstName: "Vito", lastName: "M", publicId: "vito", urn: "ACoAAvito", memberNumber: "500" },
  ]);
  const vitoQueued = r.connectedUrls.filter((u) => u === "https://linkedin.com/in/vito");
  assert.equal(vitoQueued.length, 1, "intro queued exactly once despite two rows");
  // Both row copies are resolved (neither left dangling as pending).
  assert.match(store.lead(1).connection_accepted_status, /Connected/i);
  assert.match(store.lead(2).connection_accepted_status, /Connected/i);
});

// ── #12 urn-only connection matches a lead by member id ──────────────────────
test("#12 a urn-only connection (no slug) still matches a lead by member id", async () => {
  const store = new FakeStore([
    lead({ id: 1, url: "https://linkedin.com/in/hidden", sender: ACCT_A, first: "H", last: "X",
           urn: "ACoAAhidden777" }),
  ]);
  // Connection carries only a urn — no publicId. Old store dropped it entirely.
  const r = await sweep(store, ACCT_A, [
    { firstName: "H", lastName: "X", urn: "ACoAAhidden777" },
  ]);
  assert.equal(store._conns.length, 1, "urn-only connection is KEPT, not dropped");
  assert.equal(r.connectedUrls.includes("https://linkedin.com/in/hidden"), true,
    "urn-only connection matches the lead by member id");
  assert.match(store.lead(1).connection_accepted_status, /Connected/i);
});

// ── guard: a non-sender account's sweep touches nothing ──────────────────────
test("whole-campaign feed still honors sender-scoping (non-sender sweep is a no-op)", async () => {
  const store = new FakeStore([
    lead({ id: 1, url: "https://linkedin.com/in/vito", sender: ACCT_A, first: "Vito", last: "M" }),
  ]);
  const before = store.lead(1).connection_accepted_status;
  // ACCT_B owns no rows → not an active sender → matcher returns empty.
  await sweep(store, ACCT_B, [
    { firstName: "Vito", lastName: "M", publicId: "vito", urn: "ACoAAvito", memberNumber: "500" },
  ]);
  assert.equal(store.lead(1).connection_accepted_status, before, "non-sender sweep left the row untouched");
});
