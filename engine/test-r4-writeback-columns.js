// test-r4-writeback-columns.js
//
// R4 #14 + #19 parity guard: the engine's sheet write-back must fill the SAME
// tracking columns the desktop app does — Sender / Account Used, LinkedIn URN /
// Membership ID, Connected — and emit an audit verb so the Apps Script Audit Log
// fires (it only appends when accountUsed is present). Previously buildTracking
// sent status/stage only, so those columns came back blank on every cloud run
// and the audit log never got a single entry.
//
// Pure: no DB/browser/network.  Run: node test-r4-writeback-columns.js

const { buildTracking, deriveAuditAction } = require("./campaign-sheet-writer");

let failures = 0;
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }
function ok(c, m) { if (!c) { failures++; console.error(`❌ ${m}`); } else { console.log("✅", m); } }

const cfg = { accountEmails: { "gl_profile_123": "riccardo@ortus.solutions" } };

// ── A connect_and_introduce lead, acceptance-confirmed during monitoring ──
const accepted = {
  lead_url: "https://linkedin.com/in/miera",
  assigned_profile: "gl_profile_123",
  connection_request_status: "Connection Request Sent",
  connection_accepted_status: "Connected",
  introduction_status: "",
  dm_status: "",
  stage: "Connected · DM Now",
  member_urn: "ACoAAAAapnMB-moC",
  member_number: "1746547",
  connected_already: true,
  date_last_action: "2026-07-09T13:08:38.000Z",
};
const tA = buildTracking(accepted, cfg);
eq(tA.sender, "riccardo@ortus.solutions", "sender = accountEmails[assigned_profile] (was blank on VM, audit #14)");
eq(tA.accountUsed, "riccardo@ortus.solutions", "accountUsed mirrors sender (legacy Account Used column)");
eq(tA.linkedinUrn, "ACoAAAAapnMB-moC", "linkedinUrn = member_urn → LinkedIn URN column");
eq(tA.linkedinMemberId, "1746547", "linkedinMemberId = member_number → Membership ID column");
eq(tA.connectedAlready, "Yes", "connectedAlready 'Yes' on acceptance (Connected column)");
eq(tA.checkStatus, "Connected", "acceptance still stamps Connection Accepted Status");
eq(tA.auditAction, "Acceptance confirmed", "audit verb = 'Acceptance confirmed' (most-terminal wins, audit #19)");

// ── A plain connect_only send: assigned_profile set, only stage='CC' ──
const connectSent = {
  lead_url: "https://linkedin.com/in/x",
  assigned_profile: "gl_profile_123",
  connection_request_status: "",
  connection_accepted_status: "",
  stage: "CC",
  member_urn: "",
  member_number: "",
  connected_already: false,
  date_last_action: "2026-07-09T10:00:00.000Z",
};
const tC = buildTracking(connectSent, cfg);
eq(tC.connectionStatus, "Connection Request Sent", "stage CC derives Connection Request Sent (pre-existing behavior kept)");
eq(tC.sender, "riccardo@ortus.solutions", "connect send stamps Sender");
eq(tC.auditAction, "Connection sent", "audit verb = 'Connection sent'");
ok(!("connectedAlready" in tC), "connectedAlready NOT stamped when false (never writes 'No')");
ok(!("linkedinUrn" in tC), "blank member_urn is omitted, not written empty");

// ── Auto-routed mode (message_only): no assigned_profile yet, route_account is
//    the sheet's original sender; email map has no entry → falls back to route. ──
const routed = {
  lead_url: "https://linkedin.com/in/y",
  assigned_profile: "",
  route_account: "liza.advocate@ortus.solutions",
  dm_status: "DM Sent",
  stage: "DM",
};
const tR = buildTracking(routed, cfg);
eq(tR.sender, "liza.advocate@ortus.solutions", "sender falls back to route_account when no email-map hit");
eq(tR.auditAction, "Message sent", "audit verb = 'Message sent' for DM");

// ── No account at all → no sender, no audit (not a real action) ──
const noAcct = { lead_url: "https://linkedin.com/in/z", stage: "CC", connection_request_status: "Connection Request Sent" };
const tN = buildTracking(noAcct, cfg);
ok(!("sender" in tN), "no account → no Sender stamp");
ok(!("auditAction" in tN), "no accountUsed → no audit entry (guard matches Apps Script condition)");
eq(tN.connectionStatus, "Connection Request Sent", "status columns still written even without an account");

// ── Postgres boolean-as-string tolerance ("t") ──
const tS = buildTracking({ assigned_profile: "gl_profile_123", stage: "CC", connected_already: "t" }, cfg);
eq(tS.connectedAlready, "Yes", "connected_already string 't' treated as true");

// ── deriveAuditAction ordering: intro beats connect when both present ──
eq(deriveAuditAction({ connection_request_status: "Connection Request Sent", introduction_status: "Introduction Made" }),
  "Introduction sent", "intro verb wins over connect when a lead has both");
eq(deriveAuditAction({ stage: "InMail" }), "InMail sent", "stage InMail → 'InMail sent'");
eq(deriveAuditAction({ stage: "OP Msg" }), "Open Profile message sent", "stage OP Msg → 'Open Profile message sent'");
eq(deriveAuditAction({}), "", "empty lead → no verb");

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log("\nAll R4 write-back column tests passed.");
