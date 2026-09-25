import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('public/js/app.js'), html = read('public/index.html'), engine = read('src/campaign.js'), writer = read('src/sheets-writer.js');

test('the note toggle lives in Throughput, off by default, and the note section starts hidden and enabled', () => {
  assert.match(html, /id="add-note-row" style="display:none"/);
  assert.match(html, /<input type="checkbox" id="add-note-toggle" onchange="setAddNote\(this\.checked\); wizardDirtyOnInput\(\)" \/>/);
  assert.match(html, /id="tpl-connect-section" style="display:none"/);
  assert.match(html, /<textarea id="tpl-note" maxlength="300" rows="2"/);
  assert.doesNotMatch(html, /Connection notes are disabled in this version/);
  assert.doesNotMatch(html, /<textarea id="tpl-note" hidden disabled>/);
});

test('the toggle reveals the field only for connect modes and every launch payload sends no note when off', () => {
  assert.match(app, /if \(connect\) connect\.style\.display = \(on && NOTE_MODES\.includes\(mode\)\) \? '' : 'none';/);
  assert.match(app, /_anr\.style\.display = NOTE_MODES\.includes\(mode\) \? '' : 'none'/);
  assert.match(app, /connect\.style\.display = addNoteOn \? '' : 'none';/, 'the mode handler defers to the toggle instead of always showing the section');
  assert.equal((app.match(/connectionNote: addNoteOn \? document\.getElementById\('tpl-note'\)\.value : '',/g) || []).length, 3);
  assert.equal((app.match(/connectionNote: document\.getElementById\('tpl-note'\)\.value,/g) || []).length, 2, 'template save/load builders keep the raw value');
  const at = app.indexOf('async function startNewCampaign() {');
  assert.match(app.slice(at, at + 1500), /setAddNote\(false\)/);
});

test('a campaign start clears only its own accounts from the shared Recent Connections tab, after names are known', () => {
  assert.match(writer, /export async function clearRecentConnectionsTab\(sheetUrl, accounts = null\)/);
  assert.match(writer, /\.\.\.\(Array\.isArray\(accounts\) && accounts\.length \? \{ accounts \} : \{\}\)/);
  const names = engine.indexOf('campaign.profileNames = profileIds.map(id =>');
  const clear = engine.indexOf("await clearRecentConnectionsTab(sheetUrl, (campaign.profileNames || []).filter((n) => n && n !== 'You'))");
  assert.ok(names > -1 && clear > names, 'the clear runs after the names are populated');
  assert.equal((engine.match(/clearRecentConnectionsTab\(/g) || []).length, 1);
});
