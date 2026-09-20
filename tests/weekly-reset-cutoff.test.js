import test from 'node:test';
import assert from 'node:assert/strict';
import { nextWeeklyResetMs, weeklyCutoffMs, STOP_BEFORE_RESET_MS } from '../src/weekly-reset-cutoff.js';

const iso = (ms) => new Date(ms).toISOString();

test('the reset is Monday 00:00 California time — 07:00 UTC in summer (PDT)', () => {
  // Sunday 20 Sept 2026, 10:00 UTC → Monday 21 Sept 00:00 PDT = 07:00 UTC
  assert.equal(iso(nextWeeklyResetMs(Date.parse('2026-09-20T10:00:00Z'))), '2026-09-21T07:00:00.000Z');
});

test('and 08:00 UTC in winter (PST) — daylight saving is handled', () => {
  assert.equal(iso(nextWeeklyResetMs(Date.parse('2026-12-10T12:00:00Z'))), '2026-12-14T08:00:00.000Z');
  // The week the clocks go back (Sun 1 Nov 2026): Monday 2 Nov 00:00 PST = 08:00 UTC
  assert.equal(iso(nextWeeklyResetMs(Date.parse('2026-10-30T12:00:00Z'))), '2026-11-02T08:00:00.000Z');
});

test('Monday morning UTC is still "before the reset" while it is Sunday night in California', () => {
  assert.equal(iso(nextWeeklyResetMs(Date.parse('2026-09-21T06:30:00Z'))), '2026-09-21T07:00:00.000Z');
  // Just after the reset, the next one is a week away.
  assert.equal(iso(nextWeeklyResetMs(Date.parse('2026-09-21T07:00:01Z'))), '2026-09-28T07:00:00.000Z');
});

test('the campaign stops 15 minutes before the reset', () => {
  const now = Date.parse('2026-09-20T10:00:00Z');
  assert.equal(weeklyCutoffMs(now), nextWeeklyResetMs(now) - STOP_BEFORE_RESET_MS);
  assert.equal(iso(weeklyCutoffMs(now)), '2026-09-21T06:45:00.000Z');
});

test('started inside the last 15 minutes, it aims for next week rather than stopping at once', () => {
  assert.equal(iso(weeklyCutoffMs(Date.parse('2026-09-21T06:50:00Z'))), '2026-09-28T06:45:00.000Z');
});

test('the engine takes the option, records the cutoff, and stops at a lead boundary', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /stopBeforeWeeklyReset = false/);
  assert.match(src, /campaign\.weeklyCutoffAt = stopBeforeWeeklyReset \? new Date\(weeklyCutoffMs\(Date\.now\(\)\)\)\.toISOString\(\) : null;/);
  assert.match(src, /await awaitUnpause\(myGen\);\n\s+if \(weeklyCutoffReached\(\)\) break;/);
  assert.match(src, /stopCampaign\(\{ reason: 'weekly-reset-cutoff' \}\)/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /stopBeforeWeeklyReset: stopBeforeWeeklyReset === true/); // opt-in only
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(!/stopBeforeWeeklyReset: mode ===/.test(app), 'launch payload must not reference an undefined `mode`');
});
