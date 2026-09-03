// campaign-autodm.js
//
// Phase E — CC+DM (connect_and_message) follow-up firing. The mirror of
// campaign-autointro.js MINUS the primary: when monitoring detects an
// acceptance, send a plain 1:1 DM (vendored sendMessage) and stamp
// dm_status='DM Sent'. No primary gate, no 3-way thread, no follow-up task.
//
// The send is INJECTABLE (default: the vendored sendMessage primitive) so tests
// run with no browser. _friendlyDmFailure is ported verbatim from the app.

const { leadTokenData } = require("./campaign-personalization");

let _helpers = null, _actions = null;
async function vendored() {
  if (!_helpers) _helpers = await import("./campaign-lib/linkedin/helpers.js");
  if (!_actions) _actions = await import("./campaign-lib/linkedin/actions.js");
  return { ..._helpers, ..._actions };
}

// Ported verbatim from app auto-dm.js.
function _friendlyDmFailure(errMsg) {
  const m = errMsg || "";
  if (m.includes("MESSAGE_SEND_FAILED: compose textbox did not appear")) return "Failed — Compose page didn't load";
  if (m.includes("MESSAGE_SEND_FAILED: not on a profile page")) return "Failed — Invalid lead URL";
  if (m.includes("MESSAGE_SEND_FAILED: could not type")) return "Failed — Couldn't type message";
  if (m.includes("MESSAGE_SEND_FAILED: composer not focusable")) return "Failed — Message body not focusable";
  if (m.includes("MESSAGE_SEND_FAILED: send not confirmed")) return "Failed — Send not confirmed";
  const trunc = m.length > 60 ? m.slice(0, 57) + "…" : m;
  return `Failed — ${trunc || "unknown"}`;
}

function publicIdFromUrl(url) { const m = String(url || "").match(/\/in\/([^/?#]+)/i); return m ? m[1] : ""; }

// Thin wrapper over the shared token builder (campaign-personalization.js) —
// same base map the intro path uses, so the DM body now resolves {company},
// {title}, and every custom sheet column ({Event} etc.) from row_data, exactly
// like the app's auto-dm.js data map. Was the CC+DM blank-{company} bug (#2/#3).
function dmData(lead, senderFirst) {
  return leadTokenData(lead, { senderFirst });
}

// Send DMs to the newly-accepted leads of (campaign, account). Injectable sendDm.
async function runAutoDms({ store, campaign, account, page, connectedUrls, templates = {}, sendDm }) {
  const v = await vendored();
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!Array.isArray(connectedUrls) || !connectedUrls.length) return result;
  const bodyTpl = (templates.ccDmBody || templates.followUpMessage || "").trim();
  if (!bodyTpl) { result.skipped = connectedUrls.length; return result; } // misconfigured → skip (no bogus stamp)

  const leads = await store.getCampaignLeads(campaign.id);
  const byUrl = new Map(leads.map((l) => [l.lead_url, l]));
  const senderFirst = (templates.senderFirstNames || {})[account] || "";

  for (const url of connectedUrls) {
    const lead = byUrl.get(url);
    if (!lead) { result.skipped++; continue; }
    if (lead.dm_status && String(lead.dm_status).trim() !== "") { result.skipped++; continue; } // one-shot terminal
    if (await store.wasActionSent(campaign.id, url, "message")) { result.skipped++; continue; }

    const body = v.personalizeTemplate(bodyTpl, dmData(lead, senderFirst));
    const publicId = lead.linkedin_slug || publicIdFromUrl(url);
    try {
      // vendored sendMessage throws MESSAGE_SEND_FAILED on failure → treat no-throw as sent.
      const _send = sendDm || (async (a) => { await v.sendMessage(a.page, a.body, a.publicId); return { success: true }; });
      const res = await _send({ page, leadUrl: url, body, publicId });
      if (res && res.success) {
        await store.updateLeadOutcome(lead.id, { dmStatus: "DM Sent", stage: "DM Sent" });
        await store.markActionSent(campaign.id, url, "message");
        result.sent++;
      } else {
        await store.updateLeadOutcome(lead.id, { dmStatus: _friendlyDmFailure((res && res.error) || "send failed") });
        result.failed++;
      }
    } catch (e) {
      await store.updateLeadOutcome(lead.id, { dmStatus: _friendlyDmFailure(e.message) });
      result.failed++;
    }
  }
  return result;
}

module.exports = { runAutoDms, _friendlyDmFailure, dmData };
