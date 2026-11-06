import test from 'node:test';
import assert from 'node:assert';
import { resolveSenderIdentity } from '../src/sender-identity.js';

const soo = [{ email: 'katrina.par@ortus.solutions', firstName: 'Katrina Nicole' }];

test('profile name is an email: the SoO first name wins (the OPII bug)', () => {
  const r = resolveSenderIdentity({ rowSender: 'katrina.par@ortus.solutions', profileName: 'katrina.par@ortus.solutions', sooAccounts: soo });
  assert.equal(r.name, 'Katrina Nicole');
  assert.equal(r.first, 'Katrina Nicole');
});

test('falls back to the profile name when it is the email', () => {
  const r = resolveSenderIdentity({ profileName: 'Katrina.Par@ortus.solutions ', sooAccounts: soo });
  assert.equal(r.name, 'Katrina Nicole');
});

test('operator-resolved first name wins over the SoO', () => {
  const r = resolveSenderIdentity({ profileFirst: 'Kat', rowSender: 'katrina.par@ortus.solutions', sooAccounts: soo });
  assert.equal(r.name, 'Kat');
});

test('unknown account keeps the old fallback', () => {
  const r = resolveSenderIdentity({ profileName: 'Some Label', sooAccounts: soo });
  assert.deepEqual([r.name, r.first], ['Some Label', 'Some']);
});
