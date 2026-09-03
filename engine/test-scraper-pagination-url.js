// test-scraper-pagination-url.js
//
// The ~200-lead cap fix (audit 2026-07-14). The scraper used to paginate by
// clicking numbered page buttons; past ~page 8 Sales Nav's paginator re-served
// the same page (all-dupes) or the Next fallback hit an empty page, tripping the
// dupe/empty safety-stops → every scrape ended at ~200 (8×25). Now it navigates
// by URL (&page=N), which forces a fresh Voyager fetch per page. This proves the
// withPage() URL builder that drives it — the Sales Nav `query=(...)` value must
// survive untouched (re-encoding it breaks the search).
//   node test-scraper-pagination-url.js

const { withPage } = require("./scraper");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

const SN = "https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled:true,filters:List((type:CURRENT_COMPANY,values:List((id:123)))))&sessionId=aB3xYz==";

// 1. No page param yet → append &page=N, query untouched
{
  const u = withPage(SN, 2);
  assert(u === SN + "&page=2", "appends &page=2 when absent");
  assert(u.includes("query=(spellCorrectionEnabled:true,filters:List((type:CURRENT_COMPANY,values:List((id:123)))))"),
    "Sales Nav query=(...) value preserved byte-for-byte (no re-encoding)");
  assert(u.includes("sessionId=aB3xYz=="), "other params (sessionId) preserved");
}

// 2. Existing page param → replaced, not duplicated
{
  const u = withPage(SN + "&page=1", 7);
  assert(u === SN + "&page=7", "replaces existing page=1 → page=7");
  assert((u.match(/page=/g) || []).length === 1, "exactly one page= param (no duplicate)");
}

// 3. page param in the middle of the query string → replaced in place
{
  const mid = "https://www.linkedin.com/sales/search/people?page=3&query=(x)";
  assert(withPage(mid, 9) === "https://www.linkedin.com/sales/search/people?page=9&query=(x)",
    "replaces page= even when it's the first param");
}

// 4. No query string at all → append ?page=N
{
  assert(withPage("https://www.linkedin.com/sales/search/people", 4)
    === "https://www.linkedin.com/sales/search/people?page=4", "appends ?page=N when no query string");
}

// 5. Monotonic sequence — each page distinct (the whole point: real pagination)
{
  const seen = new Set();
  for (let n = 2; n <= 40; n++) seen.add(withPage(SN, n));
  assert(seen.size === 39, "pages 2..40 all produce distinct URLs (no stuck-page repeats)");
}

console.log("\nAll scraper URL-pagination tests passed.");
