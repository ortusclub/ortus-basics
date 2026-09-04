// Renaming a campaign must MOVE it, not copy it.
//
// Settings are keyed by name, so "Save under a new name" wrote a second record
// and left the first in place: the campaign existed twice and the dashboard
// kept showing the old name (operator, 2026-09-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ortus-rename-'));
const { saveConfig, getConfig, renameConfig, listConfigs } = await import('../src/campaign-configs.js');

test('a rename moves the settings and leaves nothing behind', () => {
  saveConfig('CTAX_GUES_MUN_CCVI', { templates: { primaryIntroBody: 'munich' } });
  const r = renameConfig('CTAX_GUES_MUN_CCVI', 'CTAX_GUES_MUN_CCVII');
  assert.equal(r.ok, true);
  assert.equal(getConfig('CTAX_GUES_MUN_CCVII').config.templates.primaryIntroBody, 'munich');
  assert.equal(getConfig('CTAX_GUES_MUN_CCVI'), null, 'the old name must not survive');
  assert.equal(listConfigs().filter((c) => /^CTAX_GUES_MUN/.test(c.name)).length, 1);
});

test('renaming onto an existing campaign is refused, and neither is touched', () => {
  saveConfig('Alpha', { templates: { primaryIntroBody: 'a' } });
  saveConfig('Beta', { templates: { primaryIntroBody: 'b' } });
  const r = renameConfig('Alpha', 'Beta');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'clash');
  assert.equal(getConfig('Alpha').config.templates.primaryIntroBody, 'a');
  assert.equal(getConfig('Beta').config.templates.primaryIntroBody, 'b');
});

test('changing only capitalisation keeps the one record', () => {
  saveConfig('golf day', { templates: { primaryIntroBody: 'g' } });
  const r = renameConfig('golf day', 'Golf Day');
  assert.equal(r.ok, true);
  assert.equal(getConfig('GOLF DAY').name, 'Golf Day', "the operator's spelling is kept");
  assert.equal(listConfigs().filter((c) => /golf day/i.test(c.name)).length, 1);
});

test('renaming a campaign with no saved settings reports missing, not success', () => {
  const r = renameConfig('Never saved', 'Something else');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

test('a blank name on either side is refused', () => {
  saveConfig('Real', {});
  assert.equal(renameConfig('Real', '   ').reason, 'invalid');
  assert.equal(renameConfig('  ', 'Real').reason, 'invalid');
});
