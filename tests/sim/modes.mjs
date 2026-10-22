// Mode discovery + per-mode seed data.
//
// DISCOVERY (automatic): the campaign types the operator can pick are read live
// from MODE_LIST in public/js/app.js, minus RETIRED_MODES. A mode the engine
// drives through startCampaign() is recognised because getModeHint(mode) is
// non-null (checked by discover.mjs). So a brand-new card shows up in the report
// on its own — as covered if it has a profile below, otherwise as UNCOVERED.
//
// PROFILES (the only hand-maintained part): what a *valid* run of a mode needs —
// which rows are eligible, which templates are required, and which sheet fields
// a successful lead must be stamped with. A mode with no profile falls back to
// DEFAULT_PROFILE (cold leads, no templates) and is flagged "generic" in the report.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RETIRED_MODES } from '../../public/js/campaign-modes.mjs';

const APP_JS = fileURLToPath(new URL('../../public/js/app.js', import.meta.url));

export function discoverModeList() {
  const src = readFileSync(APP_JS, 'utf8');
  const start = src.indexOf('const MODE_LIST = [');
  if (start < 0) throw new Error('sim: MODE_LIST not found in public/js/app.js — discovery needs updating');
  const end = src.indexOf('\n];', start);
  const block = src.slice(start, end);
  const modes = [];
  for (const m of block.matchAll(/value:\s*'([a-z_]+)'\s*,\s*name:\s*'([^']+)'/g)) {
    modes.push({ value: m[1], name: m[2] });
  }
  return modes.filter(m => !RETIRED_MODES.has(m.value));
}

// Fields the operator fills in on screen for the "introduce someone" campaign types (measured on the real screen).
const PRIMARY_CONTROLS = [
  { id: 'primary-person-url', label: 'Primary person · LinkedIn URL field' },
  { id: 'primary-person-name', label: 'Primary person · name field' },
  { id: 'primary-intro-body', label: 'Introduction message box' },
];
const PRIMARY = {
  primaryName: 'Pat Primary',
  primaryUrl: 'https://www.linkedin.com/in/pat-primary/',
  primaryIntroBody: 'Hi {first name}, meet {primary name}.',
};

export const DEFAULT_PROFILE = {
  generic: true,
  leadKind: 'cold',            // cold = blank Stage, 2nd-degree, connectable
  templates: {},
  startOpts: {},
  ownedBySender: false,        // true when each lead can only be worked by its Sender account
  noDailyLimit: false,         // true when the engine intentionally ignores dailyLimit
  sends: 'invite',             // what a successful lead looks like on the fake LinkedIn
  successStamp: {},            // fields every successful row's write must carry (value or RegExp)
};

export const MODE_PROFILES = {
  connect_only: {
    leadKind: 'cold', templates: {}, startOpts: {}, sends: 'invite',
    successStamp: { stage: 'Connect Pending' },
  },
  connect_and_introduce: {
    screenControls: PRIMARY_CONTROLS, primaryChecked: true,
    leadKind: 'cold', templates: { ...PRIMARY }, startOpts: { primaryCheckTiming: 'skip' }, sends: 'invite',
    successStamp: { stage: 'Connect Pending' },
    followUp: { kind: 'intro', stamp: { introductionStatus: /Introduction Made|IC Sent/i } },
  },
  connect_and_message: {
    screenControls: [{ id: 'tpl-cc-dm-body', label: 'Message box for the DM sent after they accept' }],
    leadKind: 'cold', templates: { ccDmBody: 'Hi {first name}, thanks for connecting.' }, startOpts: {}, sends: 'invite',
    successStamp: { stage: 'Connect Pending' },
    followUp: { kind: 'dm', stamp: { dmStatus: /DM Sent/i } },
  },
  introduce_back: {
    derivesAccounts: true,   // accounts come from the sheet's Sender column, not the account picker
    senderGate: true,        // the screen checks the sender column resolves to a real account before starting
    primaryChecked: true,
    // On screen the operator must be able to choose which sheet column holds the 1st-connection sender.
    screenControls: [
      { id: 'ic-sender-col-select', label: '1st Connection column picker (which column holds the sender)', columns: true },
      ...PRIMARY_CONTROLS,
    ],
    // Leads belong to the account named in the Sender column (a healthy account can't take
    // over a broken account's leads) and the engine logs "unlimited (fast-mode)" — no daily limit.
    ownedBySender: true, noDailyLimit: true,
    leadKind: 'connected', templates: { ...PRIMARY, introName: 'Pat Primary', followUpMessage: 'Hi {first name}, I would like to introduce you to {primary name}.' }, startOpts: { allLeadsConnected: true }, sends: 'message',
    successStamp: { introStatus: /IC Sent|Introduction/i },
  },
  open_profile_only: {
    screenControls: [{ id: 'tpl-op-subject', label: 'Message subject field' }, { id: 'tpl-op-body', label: 'Message box' }],
    leadKind: 'open_profile',
    templates: { openProfileSubject: 'Hello', openProfileBody: 'Hi {first name}, quick hello.', opChannel: 'ln_only' },
    startOpts: {}, sends: 'message',
    successStamp: { opStatus: /OP Sent/i },
  },
};

export function profileFor(mode) { return MODE_PROFILES[mode] || DEFAULT_PROFILE; }
