// campaign-action.js
//
// The real per-lead action for the campaign worker, for the modes that go
// straight through performOutreach (connect_only, message_only). Each mode is
// just a different modeHint + template + "done" outcome set on the SAME reused,
// unchanged performOutreach (campaign-lib/linkedin/outreach.js).
//
// Mode contracts (confirmed from the app):
//   connect_only  → 'force_connect' · templates.connectionNote · done: connection_sent
//   message_only  → 'force_message' · templates.followUpMessage · done: message_sent
//
// (connect_and_* / introduce_back / monitoring come in Phase 3c via the scheduler.)

const campaignBrowser = require("./campaign-browser");

let _performOutreach = null;
async function getPerformOutreach() {
  if (!_performOutreach) {
    const mod = await import("./campaign-lib/linkedin/outreach.js");
    _performOutreach = mod.performOutreach;
  }
  return _performOutreach;
}

// Template tokens for a lead. Mirrors the local app: the ENTIRE source-sheet row
// becomes tokens (so {company}, {title}, {Event}, any column resolves), plus the
// canonical keys and the SENDING account's first name (senderFirst) — the piece
// that was blank in cloud connect notes.
function personalization(lead, senderFirst = "") {
  const name = (lead.full_name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const row = (lead && lead.row_data && typeof lead.row_data === "object") ? lead.row_data : {};
  const get = (...keys) => { for (const k of keys) { const v = row[k]; if (v != null && String(v).trim() !== "") return String(v); } return ""; };
  return {
    ...row, // every sheet column header is a usable token
    "first name": parts[0] || get("First Name", "first name"),
    "last name": parts.slice(1).join(" ") || get("Last Name", "last name"),
    name, "full name": name,
    company: get("Company", "company"),
    title: get("Title", "title", "Job Title", "job title"),
    "job title": get("Job Title", "job title", "Title", "title"),
    "sender first name": senderFirst || "",
    "sender name": senderFirst || "",
  };
}

// `kind` is used by the worker for the per-lead anti-dupe key + stage stamp.
const CONNECT_SPEC = {
  kind: "connect",
  hint: "force_connect",
  buildTemplates: (cfg, lead, senderFirst) => ({ connectionNote: cfg.connectionNote || "", data: personalization(lead, senderFirst) }),
  done: new Set(["connection_sent", "status_accepted", "status_pending", "already_processed"]),
  stage: (a) => (a === "connection_sent" ? "CC" : a),
};

const MODES = {
  connect_only: CONNECT_SPEC,
  // connect_and_* modes: the SEND phase is a plain connect — acceptance
  // monitoring + the intro/DM firing live in campaign-monitor/autointro/autodm,
  // driven by the scheduler (campaign-runtime arms them when sending completes).
  connect_and_introduce: CONNECT_SPEC,
  connect_and_message: CONNECT_SPEC,
  message_only: {
    kind: "message",
    hint: "force_message",
    buildTemplates: (cfg, lead, senderFirst) => ({ followUpMessage: cfg.message || cfg.followUpMessage || "", data: personalization(lead, senderFirst) }),
    done: new Set(["message_sent", "already_processed"]),
    stage: (a) => (a === "message_sent" ? "DM" : a),
  },
  // Single-pass intro to ALREADY-CONNECTED leads (no connect phase, no monitoring,
  // no primary gate). Same reused performOutreach as message_only, but with
  // introMode → it composes the 3-way intro (lead + primary). Success stamps IC.
  introduce_back: {
    kind: "intro",
    hint: "force_message",
    buildTemplates: (cfg, lead, senderFirst) => ({
      followUpMessage: cfg.primaryIntroBody || cfg.introBody || cfg.message || "",
      introMode: true,
      introName: cfg.primaryName || "",
      introUrl: cfg.primaryUrl || "",
      introTitle: cfg.introTitle || "Introduction: {first name} <> {intro name}",
      data: personalization(lead, senderFirst),
    }),
    done: new Set(["message_sent", "already_processed"]),
    stage: (a) => (a === "message_sent" ? "IC" : a),
  },
  // InMail (inmail_only) — Sales Nav composer. sendViaSalesNav routes: free
  // Open-Profile lead → OP template; else spend an InMail credit; 0 credits →
  // skipped. Reuses the same performOutreach (force_inmail).
  inmail_only: {
    kind: "inmail",
    hint: "force_inmail",
    buildTemplates: (cfg, lead, senderFirst) => ({
      openProfileSubject: cfg.openProfileSubject || cfg.opSubject || "",
      openProfileBody: cfg.openProfileBody || cfg.opBody || "",
      inmail: { subject: cfg.inmailSubject || "", message: cfg.inmailBody || cfg.inmailMessage || "" },
      data: personalization(lead, senderFirst),
    }),
    done: new Set(["inmail_sent", "op_message_sent", "message_sent", "already_processed"]),
    stage: (a) => (a === "inmail_sent" ? "InMail" : a === "op_message_sent" || a === "message_sent" ? "OP Msg" : a),
  },
  // Message Campaign / open-profile (open_profile_only) — message Open-Profile
  // members without connecting; opSpendInMail decides whether to burn an InMail
  // credit for non-OP leads. Reuses performOutreach (force_open_profile).
  open_profile_only: {
    kind: "op",
    hint: "force_open_profile",
    buildTemplates: (cfg, lead, senderFirst) => ({
      openProfileSubject: cfg.openProfileSubject || cfg.opSubject || "",
      openProfileBody: cfg.openProfileBody || cfg.opBody || "",
      opChannel: cfg.opChannel || "sn_first",
      opSpendInMail: !!cfg.opSpendInMail,
      data: personalization(lead, senderFirst),
    }),
    done: new Set(["op_message_sent", "message_sent", "inmail_sent", "already_processed"]),
    stage: (a) => (a === "inmail_sent" ? "InMail" : "OP Msg"),
  },
  // Check Status (check_status) — READ-ONLY verify of acceptance via the 1st/2nd/
  // 3rd badge (check_only). Sends nothing, so countsAsSend:false keeps it off the
  // daily SEND cap. Both outcomes are a successful check.
  check_status: {
    kind: "check",
    hint: "check_only",
    countsAsSend: false,
    buildTemplates: (cfg, lead, senderFirst) => ({ data: personalization(lead, senderFirst) }),
    done: new Set(["status_accepted", "status_pending", "already_processed"]),
    stage: (a) => (a === "status_accepted" ? "Connected" : a === "status_pending" ? "Still Pending" : a),
  },
};

// Already-connected detector — matches the app's outreach.js skip reason for a
// pre-existing 1st-degree connection ("Already connected", outreach.js:473). A CC
// to someone you're already connected to is NOT a failure: the connect just
// skips. For MONITORED intro/DM modes (connect_and_introduce / connect_and_message)
// the lead must still flow into the acceptance sweep → runAutoIntros/runAutoDms,
// exactly like the local app's idle bulk-check sweep (which stamps "Already
// connected" and fires the intro from the connected account). See the
// alreadyConnected handling in campaign-runtime actionFor + campaign-worker.
function isAlreadyConnectedSkip(result) {
  return !!(result && result.action === "skipped" && /already connected/i.test(String(result.error || "")));
}

// Pure: normalize a raw performOutreach result into the worker's action outcome.
// Exported for unit tests — the connect() path itself can't run without a real
// browser. Three shapes:
//   • a "done" action    → { success: true, stage, invitationUrn }
//   • already-connected  → { success: false, alreadyConnected: true, stage: "Already connected", error }
//   • anything else      → { success: false, error }
function mapConnectResult(result, spec) {
  const action = (result && result.action) || "unknown";
  if (spec.done.has(action)) {
    return { success: true, stage: spec.stage(action), invitationUrn: (result && result.invitationUrn) || null };
  }
  if (isAlreadyConnectedSkip(result)) {
    return { success: false, alreadyConnected: true, stage: "Already connected", error: "Already connected" };
  }
  return { success: false, error: (result && result.error) || action };
}

function makeAction(campaign) {
  const spec = MODES[campaign && campaign.mode];
  if (!spec) throw new Error(`campaign-action: unsupported mode "${campaign && campaign.mode}" (per-lead modes: ${Object.keys(MODES).join(", ")}; follower_growth is batch — see campaign-followergrowth.js)`);
  const cfg = (campaign && campaign.config) || {};
  return {
    kind: spec.kind,
    // Read-only modes (check_status) opt out of the per-account daily SEND gate.
    countsAsSend: spec.countsAsSend !== false,
    async openSession(profileId) {
      const { browser, page } = await campaignBrowser.launchProfile(profileId);
      return { profileId, browser, page };
    },
    async connect(session, lead) {
      const performOutreach = await getPerformOutreach();
      // Thread the SENDING account's first name into the template data so
      // {sender first name} resolves in the connect note (was blank — the
      // "Hi this is a test Kyra -" bug). senderFirstNames is keyed by profileId.
      const senderFirst = ((cfg.senderFirstNames || {})[session.profileId]) || "";
      const templates = spec.buildTemplates(cfg, lead, senderFirst);
      const state = { profileId: session.profileId }; // performOutreach navigates itself
      const result = await performOutreach(session.page, lead.lead_url, templates, state, spec.hint);
      return mapConnectResult(result, spec);
    },
    async closeSession(session) {
      try { await campaignBrowser.closeProfile(session.profileId); } catch {}
    },
  };
}

module.exports = { makeAction, MODES, mapConnectResult, isAlreadyConnectedSkip };
