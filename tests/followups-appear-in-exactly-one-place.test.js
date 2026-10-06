import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the board requests scoped health and indexes it by campaign', () => {
  assert.match(APP, /body: JSON\.stringify\(\{ campaigns \}\)/);
  assert.match(APP, /_followupHealthById\.set\(String\(cid\), h\)/);
  assert.doesNotMatch(APP, /fetch\('\/api\/followups\/health'\)/);
});

test('the strip is told which campaigns are on the board', () => {
  // Without this the strip and the cards would both claim the same follow-ups.
  assert.match(APP, /followups\/board/);
  assert.match(APP, /\['running', 'queued', 'idle'\]\.includes\(it\.bucket\)/);
});

test('EVERY campaign on the board gets its own numbers, not just the viewed one', () => {
  // Both live status cards render per campaign (the dashboard strip's card #2
  // and the campaign tab's #active-card). Populating only the viewed campaign
  // would blank the follow-up row on every other strip.
  assert.match(APP, /for \(const \[cid, h\] of Object\.entries\(r\.health \|\| \{\}\)\) _followupHealthById\.set/);
});

test('follow-up health is keyed by campaign, never a single global', () => {
  assert.match(APP, /const _followupHealthById = new Map\(\)/);
  assert.equal(/let _followupHealth = null;/.test(APP), false, 'the shared global must not come back');
  // Both consumers must look it up by the campaign they are rendering.
  assert.match(APP, /const h = _fuHealth\(cid\);/);
  assert.match(APP, /const _fh = _fuHealth\(cid\);/);
});

test('the strip has a mount point above the board rails', () => {
  const strip = HTML.indexOf('id="stale-followups"');
  const board = HTML.indexOf('id="campaigns-board"');
  assert.ok(strip > 0 && board > 0);
  assert.ok(strip < board, 'the strip must render above the campaign rails');
});

test('a repaint reopens the messages the operator had open', () => {
  // A board tick must not slam a long message shut mid-read.
  assert.match(APP, /const wasOpen = new Set/);
  assert.match(APP, /if \(!wasOpen\.has\(el\.dataset\.key\)\) continue;/);
});

test('discard offers an Undo, and the toast can carry one', () => {
  assert.match(APP, /label: 'Undo', onClick: \(\) => undoDiscardFollowups\(\)/);
  assert.match(APP, /function showCampaignToast\(msg, duration = 6000, action = null\)/);
  // Plain toasts must stay text-only so a campaign name can never inject markup.
  assert.match(APP, /toast\.appendChild\(document\.createTextNode\(msg\)\)/);
});
