import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFlipPayload,
  buildNeedsLoginPayload,
  buildBumpConnectionsPayload,
  isConnectSend,
  sooWritebackEnabled,
  SOO_CONN_WEEK_HEADER,
} from '../src/soo-writer.js';
import { SOO_SHEET_ID, SOO_SHEET_GID } from '../src/sheets-webapp-url.js';

test('flip payload: In Use + user cell + guard on the credit header', () => {
  const p = buildFlipPayload({
    email: 'a@ortus.solutions',
    creditHeader: 'CC (Credits)',
    userHeader: 'CC User',
    operatorEmail: 'op@ortusclub.com',
  });
  assert.equal(p.action, 'setSoO');
  assert.equal(p.sheetId, SOO_SHEET_ID);
  assert.equal(p.gid, SOO_SHEET_GID);
  assert.equal(p.email, 'a@ortus.solutions');
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use', 'CC User': 'op@ortusclub.com' });
  assert.deepEqual(p.guardAvailableFor, ['CC (Credits)']);
  // Operator stamp is sticky — write-once guard on the user column.
  assert.deepEqual(p.guardWriteOnceFor, ['CC User']);
});

test('flip payload omits the user cell when operator email is blank', () => {
  const p = buildFlipPayload({
    email: 'a@x', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: '',
  });
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use' });
});

test('needs-login payload: writes only Needs Login = Y; existing-Y guard lives in the sheet handler', () => {
  const p = buildNeedsLoginPayload({ email: 'a@x' });
  assert.equal(p.action, 'setSoO');
  assert.deepEqual(p.fields, { 'Needs Login': 'Y' });
  assert.deepEqual(p.guardAvailableFor, []);
});

test('bump payload: default +1 delta, connect-week header, correct action', () => {
  const p = buildBumpConnectionsPayload({ email: 'a@ortus.solutions' });
  assert.equal(p.action, 'bumpSoOConnections');
  assert.equal(p.sheetId, SOO_SHEET_ID);
  assert.equal(p.gid, SOO_SHEET_GID);
  assert.equal(p.email, 'a@ortus.solutions');
  assert.equal(p.delta, 1);
  assert.equal(p.header, SOO_CONN_WEEK_HEADER);
  assert.equal(p.header, 'Number of Connections (this week)');
});

test('bump payload: passes an explicit delta through', () => {
  const p = buildBumpConnectionsPayload({ email: 'a@x', delta: 3 });
  assert.equal(p.delta, 3);
});

test('isConnectSend: true only for connection_sent in a connect mode', () => {
  for (const m of ['connect_only', 'connect_and_introduce', 'connect_and_message']) {
    assert.equal(isConnectSend(m, 'connection_sent'), true, m);
  }
  // wrong action in a connect mode
  assert.equal(isConnectSend('connect_only', 'inmail_sent'), false);
  // right action but a non-connect mode
  assert.equal(isConnectSend('inmail_only', 'connection_sent'), false);
  assert.equal(isConnectSend('open_profile_only', 'connection_sent'), false);
  assert.equal(isConnectSend('message_only', 'connection_sent'), false);
});

test('general SoO writes stay disabled regardless of the legacy environment switch', () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  try {
    for (const v of ['off', '0', 'false', 'OFF', 'False']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), false, v);
    }
    for (const v of ['', 'on', '1', 'true', 'yes']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), false, v);
    }
    delete process.env.ORTUS_SOO_WRITEBACK;
    assert.equal(sooWritebackEnabled(), false);
  } finally {
    if (orig === undefined) delete process.env.ORTUS_SOO_WRITEBACK;
    else process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});
