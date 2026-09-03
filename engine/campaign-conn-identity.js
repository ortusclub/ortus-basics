// campaign-conn-identity.js
//
// Pure connection-identity helper, split out so it's unit-testable without
// loading campaign-store.js (which pulls in pg/ioredis, absent locally).
//
// R3 (#12): a connection's dedup/match identity is its strongest available key.
// Mirrors the app's Recent-Connections tab, which keeps urn-only / memberNumber-
// only rows (no slug) as real 1st-degree matches. Empty → truly keyless, skip.
function connMatchKey(c) {
  const pub = (c.publicId ?? c.public_id ?? "").toString().trim();
  const urn = (c.urn ?? "").toString().trim();
  const num = String(c.memberNumber ?? c.member_number ?? "").trim();
  return pub || urn || num || "";
}

module.exports = { connMatchKey };
