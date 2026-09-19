import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalizeTemplate, findUnresolvedPlaceholders } from '../src/linkedin/helpers.js';

// personalizeTemplate renders {token} placeholders against a per-lead data
// object built from a Google Sheet row (data = { ...row, …aliases }). The
// resolver must treat names like any other column: the token is matched to a
// sheet header regardless of casing / spacing / separators, so {first name},
// {First Name}, {firstName} and a non-English {Nome} all resolve to whatever
// the header actually is. Nothing should ever silently render the wrong (or a
// blank) name in a connection note.

test('resolves {first name} from a Title-Case "First Name" column (the connect-only bug)', () => {
  const data = { 'First Name': 'Elijah', 'Last Name': 'Kreider' };
  assert.equal(
    personalizeTemplate('Hi {first name}, great to connect.', data),
    'Hi Elijah, great to connect.',
  );
});

test('every casing / separator of the name token resolves to the same column', () => {
  const data = { 'First Name': 'Elijah' };
  for (const tok of ['{first name}', '{First Name}', '{firstName}', '{first_name}', '{FIRST NAME}', '{first-name}']) {
    assert.equal(personalizeTemplate(`Hi ${tok}!`, data), 'Hi Elijah!', `token ${tok}`);
  }
});

test('reads arbitrary / non-English headers verbatim ({nome} ← "Nome" column)', () => {
  const data = { Nome: 'Marco', Cognome: 'Rossi' };
  assert.equal(personalizeTemplate('Ciao {nome} {cognome}', data), 'Ciao Marco Rossi');
});

test('resolves a column header containing regex-special characters', () => {
  const data = { 'Job Title (Current)': 'Director' };
  assert.equal(personalizeTemplate('Role: {Job Title (Current)}', data), 'Role: Director');
});

test('computed multi-word tokens still resolve ({intro first name})', () => {
  const data = { 'intro first name': 'Sam' };
  assert.equal(personalizeTemplate('meet {intro first name}', data), 'meet Sam');
});

test('unresolved tokens are stripped, never left literal', () => {
  assert.equal(personalizeTemplate('Hi {first name}!', {}), 'Hi !');
});

test('a column that exists but is empty renders empty', () => {
  const data = { 'First Name': '' };
  assert.equal(personalizeTemplate('Hi {first name}!', data), 'Hi !');
});

test('distinct tokens do not bleed into one another ({name} vs {first name})', () => {
  const data = { 'First Name': 'Elijah', Company: 'Acme' };
  assert.equal(
    personalizeTemplate('{first name} at {company} ({name})', data),
    'Elijah at Acme ()',
  );
});

test('the real sheet header wins over a later alias on a normalized collision', () => {
  // Mirrors data = { ...row } (header first) then data.firstName = … (alias later).
  const data = {};
  data['First Name'] = 'Elijah'; // real header — inserted first
  data['firstName'] = 'WRONG';   // alias added afterwards
  assert.equal(personalizeTemplate('Hi {first name}', data), 'Hi Elijah');
});

test('replaces every occurrence of a token', () => {
  const data = { 'First Name': 'Eli' };
  assert.equal(personalizeTemplate('{first name} {first name}', data), 'Eli Eli');
});

test('empty template returns an empty string', () => {
  assert.equal(personalizeTemplate('', { 'First Name': 'Eli' }), '');
});

// findUnresolvedPlaceholders powers the preview's "{x} not resolved" warnings.
// A placeholder is "unresolved" if it would render empty — either no matching
// column/alias, or the matching value is blank.

test('findUnresolvedPlaceholders flags only tokens that render empty', () => {
  const data = { 'First Name': 'Elijah', 'Last Name': '' };
  const unresolved = findUnresolvedPlaceholders('Hi {first name} {last name} {company}', data);
  assert.deepEqual(unresolved.sort(), ['company', 'last name']);
});

test('findUnresolvedPlaceholders returns [] when everything resolves', () => {
  const data = { 'First Name': 'Elijah' };
  assert.deepEqual(findUnresolvedPlaceholders('Hi {first name}', data), []);
});


test('consistent camelCase intro title and group body resolve with legacy column aliases', () => {
  const data = { 'First Name': 'Gelioc', 'primary first name': 'Sam', 'primary last name': 'Adcock', 'primary full name': 'Sam Adcock' };
  assert.equal(personalizeTemplate('Introduction: {firstName} <> {primaryFirstName}', data), 'Introduction: Gelioc <> Sam');
  assert.equal(personalizeTemplate('Hi {firstName}, meet {primaryFirstName} ({primaryFullName}).', data), 'Hi Gelioc, meet Sam (Sam Adcock).');
});
