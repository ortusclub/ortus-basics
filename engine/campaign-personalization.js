// campaign-personalization.js
//
// Template-token data builder for campaign leads — the ENGINE mirror of the
// local app's personalization maps, kept in ONE place so the intro and DM
// paths can never drift from each other or from the app:
//   • base lead tokens     → app src/linkedin/auto-dm.js:224-236 (identical to
//                             the shared block in auto-intro.js:616-633)
//   • intro/primary tokens → app src/linkedin/auto-intro.js:634-692
//
// The app builds tokens from the SOURCE SHEET ROW (rowByUrl.get(url)). On the
// engine that same row rides on each lead as `lead.row_data` (forwarded by the
// app's campaigns-client). So everything the app does with `row`, we do with
// `lead.row_data`, SPREAD FIRST so every real sheet column ({Event}, {City},
// {Company}, …) is a usable token — then the canonical keys as fallbacks. The
// engine's structured columns (lead.first_name / lead.company / …) are a final
// fallback for leads whose row_data is empty (older leads added before the app
// began forwarding the row).
//
// Why spreading first is correct: personalizeTemplate (vendored helpers.js,
// byte-identical to the app) normalizes tokens — normalizeToken lowercases and
// strips spaces/_/-, so {Sender Name} == {sender name} == {senderName} — and
// buildTokenLookup keeps the FIRST NON-EMPTY value per normalized key. row_data
// is inserted first, so a real sheet column always beats the canonical
// fallback, and a blank column is filled by it. Byte-for-behavior identical.
//
// DO NOT let this drift from the app. If the app's map changes, change this in
// lockstep. See memory feedback_vm_must_mirror_local_exactly.

function _row(lead) {
  return lead && lead.row_data && typeof lead.row_data === "object" ? lead.row_data : {};
}

// Casing-tolerant name reads — mirror app auto-intro.js:612-615 / auto-dm.js:
// 220-223, with the engine's structured columns as a final fallback. (Token
// normalization already collapses casing at render time; the explicit ladder
// here matches the app so the VALUE we compute is identical to the app's.)
function _firstName(row, lead) {
  return (
    row["First Name"] || row["First name"] || row["first name"] ||
    row["FIRST NAME"] || row["firstName"] || row["FirstName"] || row["first_name"] ||
    (lead && lead.first_name) || ""
  );
}
function _lastName(row, lead) {
  return (
    row["Last Name"] || row["Last name"] || row["last name"] ||
    row["LAST NAME"] || row["lastName"] || row["LastName"] || row["last_name"] ||
    (lead && lead.last_name) || ""
  );
}

// Shared base — the block IDENTICAL in app auto-intro.js:616-633 and
// auto-dm.js:224-236. `senderName` is the GoLogin account display label (blank
// on the engine, which only carries `senderFirst`); `senderFirst` is the
// operator-configured nice name (senderFirstNames[profileId]). Matching the
// engine's own reference (campaign-action.js:42-43), {sender name} resolves to
// the same nice name as {sender first name} when no display label exists.
function leadTokenData(lead, { senderName = "", senderFirst = "" } = {}) {
  const row = _row(lead);
  const leadFirstName = _firstName(row, lead);
  const leadLastName = _lastName(row, lead);
  // Mirrors app auto-intro.js:707 — leadFullName drives the intro send routing
  // (clean-compose group vs URL-route). Derived from First/Last, then the
  // engine's full_name column as a fallback.
  const fullName =
    `${leadFirstName} ${leadLastName}`.trim() ||
    (lead && lead.full_name ? String(lead.full_name).trim() : "");
  const company = row["Company"] || row["company"] || (lead && lead.company) || "";
  const title = row["Title"] || row["title"] || row["Job Title"] || (lead && lead.title) || "";
  const senderFirstName =
    (senderFirst && senderFirst.trim()) || (senderName || "").split(/\s+/)[0] || "";
  const senderLabel = senderName || senderFirst || "";
  return {
    ...row, // every sheet column header is a usable token
    firstName: leadFirstName,
    lastName: leadLastName,
    "first name": leadFirstName,
    "last name": leadLastName,
    // routing helpers (also usable as {name}/{full name} tokens)
    name: fullName,
    "full name": fullName,
    company,
    title,
    "job title": title,
    // sender tokens — every spelling the app + campaign-action.js use; token
    // normalization collapses them, so these are belt-and-suspenders.
    senderName: senderLabel,
    "sender name": senderLabel,
    senderFirstName,
    "sender first name": senderFirstName,
  };
}

// Intro/primary tokens — mirrors app auto-intro.js:634-692. Adds every naming
// flavour of the primary person + the intro-name aliases. In the group-intro
// path the "intro" person IS the primary, so introName == primaryName and both
// splits come from primaryName (app auto-intro.js:532-541).
function introTokenData(
  lead,
  { primaryName = "", primaryUrl = "", senderName = "", senderFirst = "" } = {}
) {
  const base = leadTokenData(lead, { senderName, senderFirst });
  const pTok = String(primaryName || "").split(/\s+/).filter(Boolean);
  const primaryFirst = pTok[0] || "";
  const primaryLast = pTok.slice(1).join(" ");
  return {
    ...base,
    // primary — legacy "primary name", v2.14.x "primary full name", camelCase,
    // snake_case (all resolve to the same full name).
    primaryName,
    "primary name": primaryName,
    "primary full name": primaryName,
    primaryFullName: primaryName,
    primary_full_name: primaryName,
    primaryUrl: primaryUrl || "",
    "primary url": primaryUrl || "",
    "primary first name": primaryFirst,
    primaryFirstName: primaryFirst,
    primary_first_name: primaryFirst,
    "primary last name": primaryLast,
    primaryLastName: primaryLast,
    primary_last_name: primaryLast,
    // intro-name aliases (= primary in the 3-way group intro)
    "intro name": primaryName,
    introName: primaryName,
    intro_name: primaryName,
    "intro first name": primaryFirst,
    introFirstName: primaryFirst,
    intro_first_name: primaryFirst,
    "intro last name": primaryLast,
    introLastName: primaryLast,
    intro_last_name: primaryLast,
  };
}

module.exports = { leadTokenData, introTokenData };
