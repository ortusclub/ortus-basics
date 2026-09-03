// test-campaign-stage-label.js
//
// Parity guard: the cloud sheet's Stage column must read in the desktop app's
// full English wording, NOT the engine's terse internal codes. Operators saw
// cryptic "CC" next to reconciled "Connected · DM Now" in the same sheet because
// buildTracking wrote lead.stage verbatim; stageLabel now maps each code → the
// exact string src/campaign.js buildSheetDataForAction produces.
//
// Also asserts the mapping is DISPLAY-ONLY: buildTracking's internal derivations
// (which key on the raw lead.stage) still fire — a connect_only "CC" lead still
// gets connectionStatus 'Connection Request Sent'.
//
// Pure: no DB/browser/network.  Run: node test-campaign-stage-label.js

const { buildTracking, stageLabel } = require("./campaign-sheet-writer");

let failures = 0;
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }

// ── stageLabel: every engine code → the app's exact Stage wording ──
eq(stageLabel("CC"), "Connect Pending", "CC → Connect Pending");
eq(stageLabel("Still Pending"), "Connect Pending", "Still Pending → Connect Pending (app leaves the connect wording)");
eq(stageLabel("IC"), "IC Sent", "IC → IC Sent");
eq(stageLabel("DM"), "DM Sent", "DM → DM Sent");
eq(stageLabel("InMail"), "InM Sent", "InMail → InM Sent");
eq(stageLabel("OP Msg"), "OP Sent", "OP Msg → OP Sent");
eq(stageLabel("Already connected"), "Connected", "Already connected → Connected");
eq(stageLabel("dup"), "Skipped: Duplicate", "dup → Skipped: Duplicate (readable skip, never the raw code)");

// ── already_processed is MODE-DEPENDENT (app stamps the fresh-send Stage) ──
eq(stageLabel("already_processed", "connect_only"), "Connect Pending", "already_processed (connect_only) → Connect Pending");
eq(stageLabel("already_processed", "connect_and_introduce"), "Connect Pending", "already_processed (CC+IC) → Connect Pending");
eq(stageLabel("already_processed", "connect_and_message"), "Connect Pending", "already_processed (CC+DM) → Connect Pending");
eq(stageLabel("already_processed", "message_only"), "DM Sent", "already_processed (message_only) → DM Sent");
eq(stageLabel("already_processed", "introduce_back"), "IC Sent", "already_processed (introduce_back) → IC Sent");
eq(stageLabel("already_processed", "inmail_only"), "InM Sent", "already_processed (inmail_only) → InM Sent");
eq(stageLabel("already_processed", "open_profile_only"), "OP Sent", "already_processed (open_profile_only) → OP Sent");

// ── codes already in the app's wording pass through untouched ──
eq(stageLabel("Connected"), "Connected", "Connected passes through");
eq(stageLabel("Connected · DM Now"), "Connected · DM Now", "Connected · DM Now passes through");
eq(stageLabel("Skipped: Profile not found (404)"), "Skipped: Profile not found (404)", "Skipped: … passes through");
eq(stageLabel(""), "", "empty passes through");
// undefined passes straight through (put() skips null/undefined, so Stage stays unwritten — same as before).
eq(stageLabel(undefined), undefined, "undefined passes through (put() then skips it)");

// ── buildTracking writes the mapped label to the Stage key ──
const ccLead = {
  lead_url: "https://linkedin.com/in/pending-person",
  assigned_profile: "gl_p1",
  connection_request_status: "",   // one-shot connect_only leaves this blank
  connection_accepted_status: "",
  introduction_status: "",
  dm_status: "",
  stage: "CC",
};
const t = buildTracking(ccLead, { accountEmails: { gl_p1: "op@ortus.solutions" } });
eq(t.stage, "Connect Pending", "buildTracking maps a 'CC' lead's Stage → Connect Pending");
// DISPLAY-ONLY: the internal derivation keys on the raw code and still fires.
eq(t.connectionStatus, "Connection Request Sent", "raw-code derivation still fires (connectionStatus filled for CC)");

// buildTracking threads campaign mode → already_processed lands the mode's Stage.
const apLead = { lead_url: "https://linkedin.com/in/x", assigned_profile: "gl_p1", stage: "already_processed" };
eq(buildTracking(apLead, {}, "message_only").stage, "DM Sent", "buildTracking(already_processed, message_only) → DM Sent");
eq(buildTracking(apLead, {}, "connect_and_introduce").stage, "Connect Pending", "buildTracking(already_processed, CC+IC) → Connect Pending");

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll stage-label tests passed.");
