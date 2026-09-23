import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPrimaryCandidate, normalizeName } from '../src/linkedin/match-primary.js';

test('normalizeName strips diacritics and lowercases', () => {
  assert.equal(normalizeName('José María'), 'jose maria');
  assert.equal(normalizeName('  Sam   Ferrer  '), 'sam ferrer');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('exact match: configured name appears verbatim in candidate', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO at Ortus' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'exact');
  assert.equal(result.matchIndex, 0);
});

test('startsWith match: short configured name matches longer candidate', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO' }],
    'Sam'
  );
  assert.equal(result.reason, 'exact');
});

test('token-prefix match: Sam Ferrer matches Samuel Ferrer', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Samuel Ferrer · CEO at Ortus' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'token-prefix');
  assert.equal(result.matchIndex, 0);
});

test('token-prefix non-match: Sam Ferrer does NOT match Sam Fernandez', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Fernandez · CTO' }, { text: 'Jane Roe · CFO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'no-match');
  assert.equal(result.matchIndex, null);
});

test('single-candidate fallback: only one result, click it even if name does not match', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'John Doe · CFO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'single-candidate');
  assert.equal(result.matchIndex, 0);
});

test('multiple candidates, none match: no fallback', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'John Doe' }, { text: 'Jane Roe' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'no-match');
  assert.equal(result.matchIndex, null);
});

test('empty candidates array returns no-candidates', () => {
  const result = matchPrimaryCandidate([], 'Sam Ferrer');
  assert.equal(result.reason, 'no-candidates');
  assert.equal(result.matchIndex, null);
});

test('accent normalization: Perez matches José María Pérez', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'José María Pérez · Engineer' }, { text: 'John Doe' }],
    'Perez'
  );
  assert.equal(result.reason, 'token-prefix');
});

test('tier ordering: exact wins over single-candidate-fallback when both apply', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'exact');
});

test('last-initial token does not match job title words in later lines', () => {
  const result = matchPrimaryCandidate(
    [
      { text: 'Nikki C. · 1st\nHead of Growth Marketing at The Ortus Club' },
      { text: 'Dr. Nikki Noel Raheja, PhD · 1st\nCEO and Content Creator' },
      { text: 'Nikki Tan Li Yee · 1st\nCorporate Banking' },
    ],
    'Nikki C.'
  );
  assert.equal(result.reason, 'exact');
  assert.equal(result.matchIndex, 0);
});
