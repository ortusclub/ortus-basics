// test-scraper-api-pagination.js
//
// Direct-API pagination (audit 2026-07-14). UI navigation caps Sales Nav scrapes
// at ~200 (paginator button window) and outright fails on #query= fragment search
// URLs (a fragment change doesn't reload → the search API never re-fires). The
// robust fix replays the captured search API request at incrementing `start`
// offsets. This proves bumpStart() — the offset splicer that drives it — across
// the URL/GraphQL shapes a Sales Nav request can take.
//   node test-scraper-api-pagination.js

const { bumpStart } = require("./scraper");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

// 1. Query-string start= (salesApiLeadSearch GET) → replaced in place
{
  const u = "https://www.linkedin.com/sales-api/salesApiLeadSearch?q=peopleSearch&start=0&count=25";
  assert(bumpStart(u, 25) === "https://www.linkedin.com/sales-api/salesApiLeadSearch?q=peopleSearch&start=25&count=25",
    "query-string start=0 → start=25 (count untouched)");
  assert(bumpStart(u, 200).includes("start=200"), "arbitrary offset applied");
  assert((bumpStart(u, 50).match(/start=/g) || []).length === 1, "no duplicate start param");
}

// 2. GraphQL variables JSON "start": N → replaced
{
  const body = '{"variables":{"start":0,"count":25,"query":{"flagship":true}},"queryId":"voyagerSearch"}';
  assert(bumpStart(body, 75) === '{"variables":{"start":75,"count":25,"query":{"flagship":true}},"queryId":"voyagerSearch"}',
    'GraphQL "start":0 → "start":75');
}

// 3. Bare variable start:N (voyager variables=(start:0,count:25)) → replaced
{
  const u = "https://www.linkedin.com/voyager/api/graphql?variables=(start:0,count:25,origin:FACETED)&queryId=x";
  assert(bumpStart(u, 25) === "https://www.linkedin.com/voyager/api/graphql?variables=(start:25,count:25,origin:FACETED)&queryId=x",
    "bare start:0 → start:25 (only start, not count)");
}

// 4. Only the FIRST start is touched (count stays), and it's the paging one
{
  const u = "https://x/api?start=0&count=25";
  const out = bumpStart(u, 100);
  assert(out === "https://x/api?start=100&count=25", "does not touch count when bumping start");
}

// 5. No start param → best-effort append to query string
{
  assert(bumpStart("https://x/api?q=foo", 25) === "https://x/api?q=foo&start=25", "appends start when absent (has query)");
}

// 6. Distinct offsets → distinct requests (real pagination, no stuck repeats)
{
  const u = "https://x/api?start=0&count=25";
  const seen = new Set();
  for (let p = 1; p <= 100; p++) seen.add(bumpStart(u, (p - 1) * 25));
  assert(seen.size === 100, "100 pages → 100 distinct start offsets (0,25,…,2475)");
  assert(seen.has("https://x/api?start=2475&count=25"), "reaches the 2,500-result ceiling offset");
}

console.log("\nAll direct-API pagination (bumpStart) tests passed.");
