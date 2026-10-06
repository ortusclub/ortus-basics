import { appFunction } from './helpers/app-source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('cloud mutations require a successful HTTP response', () => {
  assert.match(app, /if \(!res\.ok \|\| data\.error\)/);
  assert.match(app, /_cloudMutationRequest\(`\/api\/campaign\/cloud\/\$\{encodeURIComponent\(id\)\}\/\$\{path\}`/);
  assert.match(app, /Stop was not confirmed by the VM/);
});

test('local binding does not fabricate a running state for an absent snapshot', () => {
  const bind = appFunction('_bindLiveStatusToCampaign');
  assert.match(bind, /running: !!snapshot\?\.running/);
  assert.match(bind, /state: snapshot\?\.state \|\| \(snapshot\?\.running \? null : 'done'\)/);
  assert.doesNotMatch(bind, /fetch\(|_refreshCloudActiveStatus\(/);
});

test('the rich live stage is rendered during the queued branch', () => {
  assert.match(app, /if \(!renderLiveStage\(card, status\)\) _hideStage\(card\);/);
});

test('local status transport failures preserve and visibly mark the last truth', () => {
  assert.match(app, /Local engine connection unavailable/);
  assert.match(app, /No campaign transition was inferred from this failed request/);
});
