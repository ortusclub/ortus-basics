import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldFirePostCampaignIntro } from '../src/post-campaign-bulk-check.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('public/js/app.js'), html = read('public/index.html'), server = read('server.js'), engine = read('src/campaign.js');

test('the toggle lives in the Throughput section and is offered for CC+IB only', () => {
  assert.match(html, /id="skip-intros-row" style="display:none"/);
  assert.match(html, /<input type="checkbox" id="skip-intros" onchange="syncSkipIntrosHelp\(\); wizardDirtyOnInput\(\)" \/>/);
  assert.match(app, /_sir\.style\.display = mode === 'connect_and_introduce' \? '' : 'none'/);
});

test('the wizard saves, restores, launches and checks with the toggle', () => {
  assert.match(app, /skipIntroductions: document\.getElementById\('skip-intros'\)\?\.checked === true,\n    messageOpenProfiles:/);
  assert.match(app, /_sit\.checked = config\.skipIntroductions === true;/);
  assert.match(app, /skipIntroductions: document\.getElementById\('campaign-mode'\)\?\.value === 'connect_and_introduce' && document\.getElementById\('skip-intros'\)\?\.checked === true,/);
  const at = app.indexOf('async function _launchCheckRun(scope)');
  assert.match(app.slice(at, app.indexOf("fetch('/api/bulk-check-now'", at)), /skipIntroductions: document\.getElementById\('skip-intros'\)\?\.checked === true,/);
});

test('the engine gate every intro pass consults answers no while the toggle is on', () => {
  assert.match(engine, /function _primaryIntroAllowed\(profileId\) \{[\s\S]*?if \(campaign\.skipIntroductions\) return false;/);
  assert.match(engine, /campaign\.skipIntroductions = skipIntroductions === true;/);
  assert.match(engine, /skipIntroductions,\n    \/\/ Persist excludedUrls/);
  assert.match(server, /skipIntroductions: skipIntroductions === true,/);
});

test('a manual check honours the wizard\'s answer, else the running campaign\'s', () => {
  assert.match(server, /const skipIntros = reqSkipIntros === true \|\| \(reqSkipIntros == null && !!campaign\.skipIntroductions\);/);
  const at = server.indexOf("app.post('/api/bulk-check-now'");
  const route = server.slice(at, server.indexOf("app.post('/api/bulk-check/stop'", at));
  assert.ok(route.indexOf('} else if (skipIntros && Array.isArray(r.connectedUrls)') < route.indexOf('} else if (_effectiveTemplates.primaryName && _effectiveTemplates.primaryIntroBody)'), 'the skip branch is tested before the intro branch');
});

test('post-campaign sweeps never introduce for a connections-only campaign', () => {
  const entry = { mode: 'connect_and_introduce', primaryName: 'Sam', primaryIntroBody: 'Hello' };
  assert.equal(shouldFirePostCampaignIntro(entry, ['https://linkedin.com/in/x']), true);
  assert.equal(shouldFirePostCampaignIntro({ ...entry, skipIntroductions: true }, ['https://linkedin.com/in/x']), false);
});
