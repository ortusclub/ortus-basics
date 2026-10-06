/**
 * A profile owned by another GoLogin workspace is tracked by that workspace, so
 * the Ortus SoO does not gate it at all — not the credit columns, not the
 * Status. Operator decision 2026-09-02: the workspace that owns an account is
 * the one that knows its health. The SoO verdict is still shown, as information.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { classifyAccountState } from '../public/js/account-guardrails.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf-8');
const picker = app.slice(app.indexOf('const _foreign = p.available === false;'), app.indexOf('const _foreign = p.available === false;') + 14000);

test('the lock consults who owns the profile', () => {
  assert.match(picker, /_nonOrtusRoster = !_foreign && \(\(!!p\.account && p\.account !== 'ortus'\)/);
});

test('Basics keeps SoO advisory while enforcing workspace and mode restrictions', () => {
  assert.match(picker, /const _sooLock = false;/);
  assert.match(picker, /const _locked = _foreign \|\| _wrongMode \|\| _sooLock;/);
});

test('the verdict is shown, attributed, instead of disappearing', () => {
  assert.match(picker, /_otherRosterVerdict = _nonOrtusRoster && !_noSoo/);
  assert.match(picker, /if \(_otherRosterVerdict\) \{/);
  assert.match(picker, /Ortus's SoO says/);
});

// The rows this exists for, in the shape the SoO actually returns them.
test('these are the two verdicts being told apart', () => {
  const rented = { Status: 'Rented', ccCredits: 'NA', section: 'Pool Accounts Unassigned' };
  const restricted = { Status: 'Identity Restricted', ccCredits: 'NA', section: 'Pool Accounts Unassigned' };
  assert.equal(classifyAccountState(rented, 'sam@ortusclub.com', 'connect_and_message').reason, 'na');
  assert.equal(classifyAccountState(restricted, 'sam@ortusclub.com', 'connect_and_message').reason, 'restricted');
});

test('a granted Ortus-owned account is ungated too', () => {
  // The other half of the shared inventory: owned by Ortus, driven by Linked
  // Velocity. `guest` is how the server says so.
  assert.match(picker, /p\.guest === true/);
});
