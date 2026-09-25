import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates, ASSUMED_REQUEST_STATUS } from '../src/linkedin/bulk-check-connections.js';

const ME = 'geriluz.limun@ortus.solutions';
const label = 'Still Pending (2026-09-25 12:00)';
const row = (o = {}) => ({
  'First Name': 'Romão', 'Last Name': 'Pedroso',
  'Linkedin Bio': 'https://www.linkedin.com/in/romao-pedroso',
  'Sender': ME, 'Connection Request Status': '', 'Connection Accepted Status': '', 'Introduction Status': '',
  ...o,
});
const conn = { firstName: 'Romão', lastName: 'Pedroso', publicId: 'romao-pedroso', urn: '', memberNumber: '', account: ME };
const run = (rows, conns, profileName = ME) => computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', label, { profileName });

test('Sender filled, nothing recorded, not yet accepted → assumed request + Still Pending', () => {
  const { updates, diag } = run([row()], []);
  assert.equal(diag.assumedRequest, 1);
  assert.ok(updates.some((u) => u.connectionStatus === ASSUMED_REQUEST_STATUS), 'request status is stamped as assumed');
  assert.ok(updates.some((u) => u.cc === label), 'and the row is checked like any invitation');
});

test('Sender filled, nothing recorded, accepted → assumed request + Connected (not "Already connected")', () => {
  const { updates, connectedUrls } = run([row()], [conn]);
  assert.ok(updates.some((u) => u.connectionStatus === ASSUMED_REQUEST_STATUS));
  assert.equal(updates.find((u) => u.cc)?.cc, 'Connected');
  assert.equal(connectedUrls.length, 1);
});

test('a row already stamped "Assumed…" keeps being checked on later sweeps', () => {
  const { updates, diag } = run([row({ 'Connection Request Status': ASSUMED_REQUEST_STATUS })], []);
  assert.equal(diag.assumedRequest, 0, 'not re-assumed');
  assert.ok(updates.some((u) => u.cc === label));
});

test('no Sender → untouched, as before', () => {
  const { updates } = run([row({ 'Sender': '' })], []);
  assert.deepEqual(updates, []);
});

test('another account\'s sweep never assumes for a row assigned to someone else', () => {
  const { updates } = run([row()], [], 'someone.else@ortus.solutions');
  assert.deepEqual(updates, []);
});

test('a row that already carries an acceptance result is not assumed', () => {
  const { updates } = run([row({ 'Connection Accepted Status': 'Already connected' })], []);
  assert.ok(!updates.some((u) => u.connectionStatus === ASSUMED_REQUEST_STATUS));
});
