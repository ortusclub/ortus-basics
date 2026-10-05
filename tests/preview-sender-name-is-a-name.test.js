// An operator's Intro DM preview signed off:
//
//   Thanks,
//   6a5ee8d17da88c4708b30689
//
// (2026-09-01, accounts nepal.rajwar@ortus.solutions and carl.cabico@ortus.live)
//
// /api/templates/preview had no live GoLogin session, so it stood the raw
// profile id in for the account's name: `const pName = profileId`. That line was
// there since the endpoint was written — the August fix for the same symptom
// covered the account tiles in the app window, never this.
//
// Worse than ugly: a preview that doesn't match what will be sent HID the real
// problem, which was the template using {senderName} where {senderFirstName}
// was meant.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');

test('the preview never stands a profile id in for the account name', () => {
  assert.doesNotMatch(SERVER, /const pName = profileId;/,
    'the id-as-name substitution is back');
});

test('the preview reads the account name the app resolved', () => {
  assert.match(SERVER, /const pName = \(senderNames && senderNames\[profileId\]\) \|\| '';/);
  assert.match(SERVER, /senderNames = \{\},/, 'the endpoint must accept the map');
});

test('an unknown account resolves to nothing, never to a hash', () => {
  const i = SERVER.indexOf("const pName = (senderNames");
  const line = SERVER.slice(i, SERVER.indexOf('\n', i));
  assert.doesNotMatch(line, /profileId\s*;?\s*$/,
    'falling back to the id would reintroduce the same lie');
  assert.match(line, /\|\| ''/);
});

test('the app sends the names it already knows', () => {
  assert.match(APP, /const senderNames = \{\};/);
  assert.match(APP, /senderNames\[id\] = pName;/);
});

test('the app never sends an id dressed up as a name', () => {
  // profileLabel() falls back to the raw id when nothing knows the account.
  // Passing that through would defeat the whole fix.
  assert.match(APP, /if \(pName && pName !== id\) senderNames\[id\] = pName;/);
});

test('the preview payload carries it', () => {
  const i = APP.indexOf('  return {\n    sheetUrl,\n    linkedinColumn,');
  assert.ok(i > 0, 'gatherCampaignFormState not found');
  const body = APP.slice(i, i + 500);
  assert.match(body, /senderNames,/, 'the preview request must include the map');
});

test('senderFirstName still resolves independently', () => {
  // {senderFirstName} was ALWAYS correct — it resolves to "Nepal" / "Carl" via
  // the SoO map. This fix must not disturb it, since it is what the operator
  // should be using in the template.
  assert.match(APP, /senderFirstNames\[id\] = resolveSenderFirstName\(id, pName\);/);
  assert.match(SERVER, /const resolvedFirst = \(_perRowFirst \|\| \(senderFirstNames\[profileId\] \|\| ''\)\)\.trim\(\);/);
});
