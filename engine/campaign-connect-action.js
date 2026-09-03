// campaign-connect-action.js
//
// Back-compat shim. The connect action now lives in the generic campaign-action.js
// (which also handles message_only). Kept so run-connect-validation.js and any
// connect_only callers keep working unchanged.
const { makeAction } = require("./campaign-action");

// makeAction routes by campaign.mode; for a connect_only campaign it returns the
// connect action (kind: 'connect').
function makeConnectAction(campaign) {
  return makeAction(campaign);
}

module.exports = { makeConnectAction };
