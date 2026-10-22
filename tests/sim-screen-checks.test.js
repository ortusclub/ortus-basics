import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from './sim/checks.mjs';

const failing = (checks) => checks.filter(c => !c.ok).map(c => c.name);

// ── screen scenario: judged on what the operator can see ──
const screen = (o = {}) => ({ steps: [{ name: 'app-opens', ok: true }], failedStep: null, controls: [], errors: [], ...o });
const SCREEN = { kind: 'screen', mode: 'introduce_back' };

test('screen: every control visible and no script errors → clean', () => {
  assert.deepEqual(failing(runChecks(SCREEN, screen({ controls: [{ label: 'a', ok: true }] }))), []);
});
test('screen: a hidden picker is reported with the reason', () => {
  const c = runChecks(SCREEN, screen({ controls: [{ label: '1st Connection column picker', ok: false, detail: 'hidden (ic-extras-filled has display:none)' }] }));
  assert.deepEqual(failing(c), ['screen-controls-available']);
  assert.match(c.find(x => !x.ok).detail, /1st Connection column picker — hidden/);
});
test('screen: a step that could not be done fails setup and is not also blamed on the controls', () => {
  const c = runChecks(SCREEN, screen({ failedStep: { name: 'preview-sheet-button', detail: 'no "Preview sheet" button' } }));
  assert.deepEqual(failing(c), ['screen-setup-completes']);
});
test('screen: script errors and pop-up alerts fail the screen', () => {
  assert.deepEqual(failing(runChecks(SCREEN, screen({ errors: ['TypeError: x is null'] }))), ['screen-no-script-errors']);
});

// ── "press Start" scenario: good setup accepted, bad setup refused with a readable reason ──
const GATES = { kind: 'gates', mode: 'connect_only' };
const refused = (name, status = 400, error = 'sheetUrl required') => ({ name, expect: 'refused', status, reply: { error } });
const good = (status = 200, reply = { ok: true, message: 'Campaign started' }) => ({ name: 'good-setup', expect: 'accepted', status, reply });

test('gates: refusals with readable reasons and an accepted good setup → clean', () => {
  assert.deepEqual(failing(runChecks(GATES, { cases: [refused('no-sheet-link'), good()] })), []);
});
test('gates: a bad setup that is accepted is a finding, and says which one', () => {
  const c = runChecks(GATES, { cases: [{ name: 'no-linkedin-urls-in-sheet', expect: 'refused', status: 200, reply: { ok: true, message: 'Campaign started' } }, good()] });
  assert.deepEqual(failing(c), ['start-refuses-bad-setups']);
  assert.match(c.find(x => !x.ok).detail, /no-linkedin-urls-in-sheet: it was accepted/);
});
test('gates: a refusal with no readable reason (undefined / empty / server error) is a finding', () => {
  for (const bad of [refused('a', 400, ''), refused('b', 400, 'undefined'), refused('c', 500, 'boom')]) {
    assert.deepEqual(failing(runChecks(GATES, { cases: [bad, good()] })), ['start-refuses-bad-setups'], bad.name);
  }
});
test('gates: a good setup that is refused is a finding', () => {
  assert.deepEqual(failing(runChecks(GATES, { cases: [good(400, { error: 'nope' })] })), ['start-accepts-good-setup']);
});
test('gates: the sender-column check must flag a blank column and pass a filled one', () => {
  const blank = (reply) => ({ name: 'sender-column-blank', expect: 'sender-check-says-no', status: 200, reply });
  const filled = (reply) => ({ name: 'sender-column-filled', expect: 'sender-check-says-yes', status: 200, reply });
  assert.deepEqual(failing(runChecks(GATES, { cases: [blank({ ok: false, reason: 'no_column' }), filled({ ok: true }), good()] })), []);
  assert.deepEqual(failing(runChecks(GATES, { cases: [blank({ ok: true }), filled({ ok: true }), good()] })), ['sender-check-works']);
  assert.deepEqual(failing(runChecks(GATES, { cases: [blank({ ok: false }), filled({ ok: false }), good()] })), ['sender-check-works']);
});
test('gates: if the server could not start, that is reported instead of silently passing', () => {
  assert.deepEqual(failing(runChecks(GATES, { failed: 'The app server did not start' })), ['start-checks-run']);
});
