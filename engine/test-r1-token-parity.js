// test-r1-token-parity.js
//
// R1 parity guard: the engine must build the SAME template tokens the local app
// does, from the source-sheet row carried as lead.row_data. Proves the fix end
// to end by RENDERING templates through the real vendored personalizeTemplate
// (campaign-lib/linkedin/helpers.js — byte-identical to the app), so token
// normalization, custom columns and every naming flavour are exercised for real.
// Pure: no DB/browser.  Run: node test-r1-token-parity.js

const { leadTokenData, introTokenData } = require("./campaign-personalization");
const { dmData } = require("./campaign-autodm");
const { leadToRow } = require("./campaign-monitor");

let failures = 0;
function ok(cond, m) { if (!cond) { failures++; console.error(`❌ ${m}`); } else { console.log("✅", m); } }
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }

(async () => {
  const { personalizeTemplate } = await import("./campaign-lib/linkedin/helpers.js");

  // Lead as ingested on the VM: structured columns blank, the real sheet row in
  // row_data — including a CUSTOM column ({Event}) the operator added.
  const lead = {
    full_name: "Miera Rotas", first_name: "", last_name: "", company: "", title: "",
    row_data: {
      "First Name": "Miera", "Last Name": "Rotas",
      "Company": "Google", "Title": "Head of Ops",
      "Event": "Dubai Summit",
    },
  };

  // ── DM path (CC+DM): {company}/{title}/{Event} were blank on the VM ──
  const dmBody = personalizeTemplate(
    "Hi {first name}, Head of {title} at {company} — great to connect after {Event}. — {sender first name}",
    dmData(lead, "Alcris")
  );
  eq(dmBody, "Hi Miera, Head of Head of Ops at Google — great to connect after Dubai Summit. — Alcris",
    "CC+DM body renders {company}/{title}/{Event}/{sender first name} (all were blank on VM)");

  // ── Intro path (CC+IC): the exact prod bug string ──
  const introBody = personalizeTemplate(
    "hi {first name} of {company}, this is {sender first name}, here is {primary full name}",
    introTokenData(lead, { primaryName: "Antonio Varlese", primaryUrl: "https://linkedin.com/in/antoniovarlese", senderFirst: "Alcris" })
  );
  eq(introBody, "hi Miera of Google, this is Alcris, here is Antonio Varlese",
    "CC+IC body renders {company}/{sender first name}/{primary full name} (the prod blank-token bug)");

  // ── every naming flavour normalizes to the same value ──
  const idata = introTokenData(lead, { primaryName: "Antonio Varlese", senderFirst: "Alcris" });
  eq(personalizeTemplate("{Primary_Full_Name}|{primaryName}|{PRIMARY NAME}", idata),
    "Antonio Varlese|Antonio Varlese|Antonio Varlese", "casing/spacing/underscore flavours all resolve to primary");
  eq(personalizeTemplate("{intro last name}|{primary last name}", idata), "Varlese|Varlese", "intro/primary last name (audit #22)");
  eq(personalizeTemplate("{sender name}", idata), "Alcris", "{sender name} resolves (audit #20)");

  // ── routing key used by runAutoIntros to pick clean-compose vs URL-route ──
  eq(idata["full name"], "Miera Rotas", "data['full name'] = First + Last (routing; app auto-intro.js:707)");
  const noName = introTokenData({ full_name: "", row_data: {} }, { primaryName: "P" });
  eq(noName["full name"], "", "no name → blank full name → runAutoIntros falls to URL-route (app parity)");

  // ── app parity: sheet column wins; structured field is the fallback ──
  eq(leadTokenData({ company: "StructCo", row_data: { "Company": "SheetCo" } })["company"], "SheetCo",
    "sheet Company column beats structured field (app only reads the sheet row)");
  eq(leadTokenData({ company: "StructCo", row_data: {} })["company"], "StructCo",
    "structured company is the fallback when the sheet has no Company column");

  // ── leadToRow: Member-ID axis passes through; DB status stays authoritative ──
  const monLead = {
    lead_url: "https://linkedin.com/in/miera",
    first_name: "Miera", last_name: "Rotas",
    connection_accepted_status: "", // DB says not-yet-accepted
    connection_request_status: "Connect Request Sent",
    member_urn: "urn:li:fsd_profile:ABC",
    row_data: {
      "LinkedIn Membership ID": "123456789",
      "Connection Accepted Status": "Connected", // STALE import snapshot
      "Event": "Dubai Summit",
    },
  };
  const row = leadToRow(monLead);
  eq(row["LinkedIn Membership ID"], "123456789", "source Member-ID column passes through (enables num: axis, audit #16)");
  eq(row["Connected Status"], "", "DB acceptance status wins (empty)");
  ok(!("Connection Accepted Status" in row), "stale row_data 'Connection Accepted Status' is NOT leaked into the matcher row");
  eq(row["LinkedIn URL"], "https://linkedin.com/in/miera", "canonical linkedin url set");
  eq(row["LinkedIn URN"], "urn:li:fsd_profile:ABC", "URN mapped from DB");
  ok(!("Event" in row), "custom columns are NOT spread into the matcher row (not needed; avoids noise)");

  // readSourceMemberId (the real vendored primitive) must extract the num axis.
  const { readSourceMemberId } = await import("./campaign-lib/profile-identity.js");
  eq(readSourceMemberId(row), "123456789", "readSourceMemberId reads the passed-through Member-ID (was '' on VM)");

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log("\nAll R1 token-parity tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
