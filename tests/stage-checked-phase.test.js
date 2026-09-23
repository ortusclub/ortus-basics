import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestBannerEvent, bannerEventPhase } from '../public/js/live-log-banner.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('a completed check is a record, not a live checking phase', () => {
  const e = latestBannerEvent(['[2026-09-23T18:43:01.918Z] 📡 Manual bulk check complete — 2 Connected, 144 Still Pending across 4 account(s).']);
  assert.equal(e.kind, 'check-complete');
  assert.equal(bannerEventPhase(e, 'checking'), 'checked');
  assert.equal(bannerEventPhase(e, ''), 'checked');
  assert.equal(bannerEventPhase(e, 'monitoring'), 'monitoring');
});

test('an in-flight check still drives the live checking phase', () => {
  const e = latestBannerEvent(['[2026-09-23T18:41:29.100Z] 📡 [iliya@ortus.solutions] Sweeping recent connections…']);
  assert.equal(bannerEventPhase(e, ''), 'checking');
});

test('the checked phase renders static: tick glyph, done class, no live panels', () => {
  assert.match(app, /if \(phase === 'done' \|\| phase === 'checked'\) return '<span class="stg-done">✓<\/span>';/);
  assert.match(app, /stage\.classList\.toggle\('is-done', phase === 'done' \|\| phase === 'checked'\);/);
  assert.match(app, /if \(phase !== 'done' && phase !== 'checked'\) \{/);
  assert.match(app, /\} else if \(phase === 'checked'\) \{\n\s+side = \['Check finished', 'Nothing is running'/);
  assert.match(app, /if \(p === 'checked'\) \{\n\s+return \[\n\s+\['Request', 'check complete', 'done'\]/);
});
