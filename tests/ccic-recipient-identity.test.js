/**
 * Same-name recipient disambiguation for the CC+IC clean-compose typeahead
 * (boss + Antonio, 2026-06-16; verified live against LinkedIn the same day).
 *
 * The messaging typeahead dropdown exposes NO slug/member-id — only name,
 * degree, headline, and the avatar. Live proof: typing "Kyra De la Cruz"
 * returned TWO different same-name people, NEITHER being the intended Kyra.
 * So when >1 candidate shares the name we must disambiguate by PROFILE PHOTO
 * (the avatar media-id token, which is stable between the dropdown and the
 * person's profile page) — and if no candidate's photo matches the intended
 * person, SKIP rather than message a stranger.
 *
 * pickRecipientByIdentity is the pure decision — the browser-side selector in
 * actions.js mirrors it (same hand-kept-in-sync pattern as matchPrimaryCandidate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecipientByIdentity } from '../src/linkedin/match-primary.js';

// candidate shape: { text, is1st, isGroup, avatarToken }
const c = (text, is1st, avatarToken, isGroup = false) => ({ text, is1st, isGroup, avatarToken });

test('single 1st-degree name match → use it (no reference photo needed)', () => {
  const cands = [c('Pinky Salaria • 1st', true, 'TOKEN_PINKY')];
  const r = pickRecipientByIdentity(cands, { name: 'Pinky Salaria' });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'single');
});

test('two same-name 1st-degree, reference photo matches one → pick that one', () => {
  const cands = [
    c('Kyra De La Cruz • 1st', true, 'TOKEN_A'),
    c('kyra de la cruz • 1st', true, 'TOKEN_B'),
  ];
  const r = pickRecipientByIdentity(cands, { name: 'Kyra De la Cruz', expectedAvatarToken: 'TOKEN_B' });
  assert.equal(r.index, 1);
  assert.equal(r.reason, 'avatar-match');
});

test('two same-name 1st-degree, reference photo matches NONE → skip (never guess)', () => {
  const cands = [
    c('Kyra De La Cruz • 1st', true, 'TOKEN_A'),
    c('kyra de la cruz • 1st', true, 'TOKEN_B'),
  ];
  // The intended Kyra (TOKEN_REAL) is not even in the dropdown — the live case.
  const r = pickRecipientByIdentity(cands, { name: 'Kyra De la Cruz', expectedAvatarToken: 'TOKEN_REAL' });
  assert.equal(r.index, -1);
  assert.equal(r.reason, 'ambiguous-no-photo-match');
});

test('two same-name 1st-degree, no reference photo available → skip (cannot disambiguate)', () => {
  const cands = [
    c('Kyra De La Cruz • 1st', true, 'TOKEN_A'),
    c('Kyra De La Cruz • 1st', true, 'TOKEN_B'),
  ];
  const r = pickRecipientByIdentity(cands, { name: 'Kyra De la Cruz' });
  assert.equal(r.index, -1);
  assert.equal(r.reason, 'ambiguous-no-reference');
});

test('group-message rows are ignored (only real people are recipients)', () => {
  const cands = [
    c('Introduction: <> Antonio | Group Message • 3 participants', false, 'TOKEN_X', true),
    c('Pinky Salaria • 1st', true, 'TOKEN_PINKY'),
  ];
  const r = pickRecipientByIdentity(cands, { name: 'Pinky Salaria' });
  assert.equal(r.index, 1);
  assert.equal(r.reason, 'single');
});

test('no name match → no-match (caller treats as recipient-not-found)', () => {
  const cands = [c('Someone Else • 1st', true, 'TOKEN_Z')];
  const r = pickRecipientByIdentity(cands, { name: 'Pinky Salaria' });
  assert.equal(r.index, -1);
  assert.equal(r.reason, 'no-match');
});

test('reference photo present but only one name match → still use it (no ambiguity to resolve)', () => {
  const cands = [c('Pinky Salaria • 1st', true, 'TOKEN_PINKY')];
  const r = pickRecipientByIdentity(cands, { name: 'Pinky Salaria', expectedAvatarToken: 'TOKEN_PINKY' });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'single');
});

test('last-initial name does not false-match on job title words (Nikki C. bug)', () => {
  const cands = [
    c('Nikki C. • 1st\nHead of Growth Marketing at The Ortus Club', true, 'TOKEN_NC'),
    c('Dr. Nikki Noel Raheja, PhD • 1st\nCEO and Content Creator at TTPJ Productions', true, 'TOKEN_NR'),
    c('Nikki Tan Li Yee • 1st\nCorporate Banking', true, 'TOKEN_NT'),
  ];
  const r = pickRecipientByIdentity(cands, { name: 'Nikki C.' });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'single');
});
