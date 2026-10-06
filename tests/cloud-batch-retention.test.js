import { appFunction } from './helpers/app-source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('local campaign snapshots retain batch progress intact', () => {
  const selected = { id: 'a', status: {} };
  const incoming = { id: 'a', batchDone: 3, batchSize: 5, running: true };
  const view = new Function('_viewingLocalCampaign', 'location', 'sameCampaign',
    appFunction('localCampaignViewStatus') + '; return localCampaignViewStatus;')(
      selected, { hash: '#/new' }, () => true);
  const status = view(incoming);
  assert.equal(status.batchDone, 3);
  assert.equal(status.batchSize, 5);
  assert.equal(status._cloud, false);
});

test('Open sheet is rendered only in the canonical campaign control row', () => {
  assert.match(src, /if \(txt\.includes\('open sheet'\)\) \{ b\.style\.display = 'none'; return; \}/);
});
