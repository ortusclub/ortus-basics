import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates, memberNumberFromToken, leadIdentityKeys } from '../src/linkedin/bulk-check-connections.js';

// Real pair (2026-09-23, APHI CC1): the sheet URL token and the connections
// URN differ as strings but encode the same member, 17000174.
const SHEET_TOKEN = 'ACwAAAEDZu4B8zkH5-aHzwA5Ndi_l-D9YK3TsF4';
const CONN_URN = 'ACoAAAEDZu4BnXwaMh7vrMK2PWijJOUDHZW07Dg';
const label = 'Still Pending (2026-09-25 11:00)';

test('both token forms decode to the same member number', () => {
  assert.equal(memberNumberFromToken(SHEET_TOKEN), '17000174');
  assert.equal(memberNumberFromToken(`http://www.linkedin.com/in/${SHEET_TOKEN}`), '17000174');
  assert.equal(memberNumberFromToken(CONN_URN), '17000174');
  assert.equal(memberNumberFromToken('ACoAAABbty4B6aBk0Q7Ooq9LzL_tEFiDCfcnrsI'), '6010670');
  assert.equal(memberNumberFromToken('ACoAAGpiKW8B0eIhVSKo_5P5K9SlL_F4cIUoG_E'), '1784818031');
  assert.equal(memberNumberFromToken('jane-doe'), '');
  assert.equal(memberNumberFromToken(''), '');
});

test('an ACwAA sheet row with no numeric id column matches its ACoAA connection (2026-09-25: 73 leads reported 0 Connected)', () => {
  const rows = [{
    'First Name': 'Michelle', 'Last Name': 'Bradshaw',
    'Linkedin Bio': `http://www.linkedin.com/in/${SHEET_TOKEN}`,
    'Linkedin Membership ID': '33062150302', // a CRM record id, not LinkedIn's
    'Sender': 'katte.nato@ortus.solutions',
    'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': '',
  }];
  const conns = [{ firstName: 'Michelle', lastName: 'Bradshaw', publicId: 'michbradshaw', urn: CONN_URN, memberNumber: '', account: 'katte.nato@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', label, { profileName: 'katte.nato@ortus.solutions' });
  assert.equal(connectedUrls.length, 1);
  assert.equal(updates.find((u) => u.cc === 'Connected')?.linkedinUrl, `http://www.linkedin.com/in/${SHEET_TOKEN}`);
});

test('a namesake with a different member number still does not match', () => {
  const rows = [{
    'First Name': 'Michelle', 'Last Name': 'Bradshaw',
    'Linkedin Bio': `http://www.linkedin.com/in/${SHEET_TOKEN}`,
    'Sender': 'katte.nato@ortus.solutions',
    'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': '',
  }];
  const conns = [{ firstName: 'Michelle', lastName: 'Bradshaw', publicId: 'michelle-bradshaw-2', urn: 'ACoAAABbty4B6aBk0Q7Ooq9LzL_tEFiDCfcnrsI', memberNumber: '6010670', account: 'katte.nato@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', label, { profileName: 'katte.nato@ortus.solutions' });
  assert.equal(connectedUrls.length, 0);
  assert.equal(updates[0]?.cc, label);
});

test('identity keys carry the decoded number so URL-form duplicates collapse', () => {
  const a = leadIdentityKeys(`https://www.linkedin.com/in/${SHEET_TOKEN}`, {});
  const b = leadIdentityKeys(`https://www.linkedin.com/in/${CONN_URN}`, {});
  assert.ok(a.includes('num:17000174') && b.includes('num:17000174'));
});
