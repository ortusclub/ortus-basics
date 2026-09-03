// test-campaign-live-registry.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeLiveRegistry } = require("./campaign-live-registry.js");

function fakeRedis() {
  const store = new Map(); const calls = [];
  return {
    store, calls,
    async set(k, v, ex, n) { calls.push(["set", k, v, ex, n]); store.set(k, v); return "OK"; },
    async del(k) { calls.push(["del", k]); return store.delete(k) ? 1 : 0; },
    async expire(k, n) { calls.push(["expire", k, n]); return store.has(k) ? 1 : 0; },
  };
}
const PAGE = { _fake: "page" };

test("register stores in-process + stamps redis with TTL", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000", ttlSec: 30 });
  await reg.register("cmp1", "acctA", PAGE);
  assert.equal(reg.get("cmp1").page, PAGE);
  assert.equal(reg.get("cmp1").account, "acctA");
  const setCall = r.calls.find((c) => c[0] === "set" && c[1] === "cmp:live:cmp1");
  assert.ok(setCall, "redis key stamped");
  const val = JSON.parse(setCall[2]);
  assert.equal(val.podIP, "10.0.0.9");
  assert.equal(val.account, "acctA");
  assert.equal(setCall[3], "EX");
  assert.equal(setCall[4], 30);
});

test("unregister removes in-process + DELs redis when it owns the slot", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.unregister("cmp1", "acctA");
  assert.equal(reg.get("cmp1"), null);
  assert.ok(r.calls.some((c) => c[0] === "del" && c[1] === "cmp:live:cmp1"), "redis DEL");
});

test("unregister by a stale account does NOT evict a newer holder", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.register("cmp1", "acctB", PAGE);
  await reg.unregister("cmp1", "acctA");
  assert.equal(reg.get("cmp1").account, "acctB", "newer holder survives");
  assert.ok(!r.calls.some((c) => c[0] === "del"), "no DEL while B still live");
});

test("redis failure in register never throws", async () => {
  const boom = { async set() { throw new Error("redis down"); }, async del() {}, async expire() {} };
  const reg = makeLiveRegistry({ redis: boom, podIP: "x", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  assert.equal(reg.get("cmp1").account, "acctA");
});

test("progress re-stamps the SAME key with a merged progress field (account + pod intact)", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000", ttlSec: 30 });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.progress("cmp1", "acctA", { selecting: "Taylor Deley", done: 9, total: 30 });
  assert.deepEqual(reg.get("cmp1").progress, { selecting: "Taylor Deley", done: 9, total: 30 });
  const last = [...r.calls].reverse().find((c) => c[0] === "set" && c[1] === "cmp:live:cmp1");
  const val = JSON.parse(last[2]);
  assert.equal(val.account, "acctA", "account preserved");
  assert.equal(val.podIP, "10.0.0.9", "pod preserved");
  assert.deepEqual(val.progress, { selecting: "Taylor Deley", done: 9, total: 30 });
  assert.equal(last[3], "EX");
  assert.equal(last[4], 30, "TTL refreshed");
});

test("progress by a stale account does NOT overwrite a newer holder", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.register("cmp1", "acctB", PAGE);
  await reg.progress("cmp1", "acctA", { selecting: "X", done: 1, total: 2 });
  assert.equal(reg.get("cmp1").account, "acctB");
  assert.equal(reg.get("cmp1").progress, undefined, "newer holder unprogressed");
});

test("progress redis failure never throws", async () => {
  const boom = { async set() { throw new Error("redis down"); }, async del() {}, async expire() {} };
  const reg = makeLiveRegistry({ redis: boom, podIP: "x", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.progress("cmp1", "acctA", { selecting: "Y", done: 1, total: 3 });
  assert.deepEqual(reg.get("cmp1").progress, { selecting: "Y", done: 1, total: 3 });
});
