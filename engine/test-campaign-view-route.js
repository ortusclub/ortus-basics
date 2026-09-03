// test-campaign-view-route.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mountCampaignApi } = require("./campaign-api.js");

function fakeApp() {
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { get: reg("GET"), post: reg("POST"), routes };
}
function fakeRes() {
  return { code: 200, headers: null, ended: false,
    status(c){ this.code=c; return this; }, json(b){ this.body=b; return this; },
    writeHead(c,h){ this.code=c; this.headers=h; return this; }, end(){ this.ended=true; } };
}
function storeWith(liveKeys) {
  return {
    redis: { async get(k){ return liveKeys[k] || null; } },
    pg: { async query(){ return { rows: [
      { id: "cmp1", name: "A", status: "running" },
      { id: "cmp2", name: "B", status: "monitoring" }] }; } },
    getCampaign: async (id) => ({ id, name: "A", status: "running" }),
    leadStatusCounts: async () => ({ sent: 3 }),
  };
}

test("list folds live flag from cmp:live:<id>", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "acctA", podIP: "10.0.0.9" }) }));
  const res = fakeRes();
  await app.routes["GET /api/campaign/list"]({ query: {} }, res);
  const byId = Object.fromEntries(res.body.campaigns.map((c) => [c.id, c]));
  assert.equal(byId.cmp1.live, true);
  assert.equal(byId.cmp1.liveAccount, "acctA");
  assert.equal(byId.cmp2.live, false);
});

test(":id folds live flag", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "acctA", podIP: "10.0.0.9" }) }));
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id"]({ params: { id: "cmp1" }, query: {} }, res);
  assert.equal(res.body.live, true);
  assert.equal(res.body.liveAccount, "acctA");
});

test("view: 404 no active session when no stamp", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({}));
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id/view"]({ params: { id: "cmp1" }, query: {}, on(){} }, res);
  assert.equal(res.code, 404);
  assert.deepEqual(res.body, { error: "no active session" });
});

test("view: proxies when a live stamp with podIP exists", async () => {
  const app = fakeApp();
  const proxied = [];
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "a", podIP: "10.0.0.9", podPort: 3000 }) }),
    { proxyStream: (target, _req, _res) => { proxied.push(target); } });
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id/view"]({ params: { id: "cmp1" }, query: {}, on(){} }, res);
  assert.equal(proxied.length, 1);
  assert.match(proxied[0], /^http:\/\/10\.0\.0\.9:3000\/api\/campaign\/cmp1\/view\?internal=1$/);
});

test("liveOf degrades to not-live when redis hangs (no board hang)", async () => {
  const app = fakeApp();
  const hangingStore = {
    redis: { get: () => new Promise(() => {}) }, // never resolves
    pg: { async query(){ return { rows: [{ id: "cmp1", name: "A", status: "running" }] }; } },
  };
  mountCampaignApi(app, hangingStore, { liveTimeoutMs: 10 });
  const res = fakeRes();
  await app.routes["GET /api/campaign/list"]({ query: {} }, res);  // must not hang
  assert.equal(res.body.campaigns[0].live, false);
});
