import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'ortus-permanent-identity-'));
process.env.ORTUS_DATA_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const registry = await import('../src/campaign-configs.js');
const { migrateCampaignIdentities } = await import('../src/campaign-identity-migration.js');
const put = (file, value) => writeFileSync(join(root, file), JSON.stringify(value));
const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));

test('legacy migration preserves settings, links stores, backs up files and is repeatable', () => {
  const legacy = { sam: { name: 'Sam', config: { sheetUrl: 'sheet-1', templates: { note: 'hello' } }, savedAt: '2026-01-01' } };
  put('campaign-configs.json', legacy);
  for (const file of ['drafts.json', 'queued-campaigns.json', 'history.json', 'schedules.json']) put(file, [{ id: file, name: 'SAM', config: { sheetUrl: 'sheet-1' } }]);
  put('last-run-settings.json', { name: 'Sam', dailyLimit: 75 });
  put('runtime-interruption.json', { name: 'Sam', campaignId: 'legacy-singleton', active: true });
  migrateCampaignIdentities();
  const id = registry.getConfig('Sam').campaignId;
  assert.ok(id);
  assert.equal(registry.getConfigById(id).config.templates.note, 'hello');
  assert.deepEqual(read('campaign-configs.json.before-ids.bak'), legacy);
  for (const file of ['drafts.json', 'queued-campaigns.json', 'history.json', 'schedules.json']) {
    assert.equal(read(file)[0].campaignId, id);
    assert.equal(read(file)[0].config.campaignId, id);
    assert.equal(read(file + '.before-ids.bak')[0].campaignId, undefined);
  }
  assert.equal(read('runtime-interruption.json').campaignId, 'legacy-singleton');
  assert.equal(read('runtime-interruption.json').permanentCampaignId, id);
  const before = readFileSync(join(root, 'campaign-configs.json'), 'utf8');
  migrateCampaignIdentities();
  assert.equal(readFileSync(join(root, 'campaign-configs.json'), 'utf8'), before);
});

test('rename and queue preserve identity; duplicate has a separate ID; conflicting edits change nothing', async () => {
  const { addToQueue, getQueue, updateQueueEntry, clearQueue } = await import('../src/campaign-queue.js');
  await clearQueue();
  const original = registry.getConfig('Sam');
  const queued = await addToQueue({ ...original.config, name: 'Sam' });
  registry.renameConfig('Sam', 'Sam renamed', original.campaignId);
  assert.equal(registry.getConfigById(original.campaignId).name, 'Sam renamed');
  assert.equal((await getQueue())[0].name, 'Sam renamed');
  const duplicate = registry.saveConfig('Sam II', { ...original.config, campaignId: undefined }, { create: true });
  assert.notEqual(duplicate.campaignId, original.campaignId);
  assert.throws(() => registry.saveConfig(' sam ii ', {}, { campaignId: original.campaignId }), /already exists/);
  await assert.rejects(updateQueueEntry(queued.id, { name: 'Corrupted', config: { campaignId: duplicate.campaignId } }), /identity/);
  assert.equal((await getQueue())[0].name, 'Sam renamed');
  assert.equal(registry.getConfigById(original.campaignId).config.sheetUrl, 'sheet-1');
  assert.throws(() => registry.saveConfig('Missing', {}, { campaignId: 'missing' }), /no longer exists/);
});

test('unnamed drafts get distinct IDs that survive naming and reject another campaign configuration', async () => {
  const { addDraft, updateDraft, DRAFT_IDENTITY_MISMATCH } = await import('../src/drafts.js');
  const a = await addDraft(), b = await addDraft();
  assert.notEqual(a.campaignId, b.campaignId);
  const updated = await updateDraft(a.id, { name: 'New draft', config: { campaignId: a.campaignId, sheetUrl: 'sheet-a' } });
  assert.equal(updated.campaignId, a.campaignId);
  assert.equal(await updateDraft(a.id, { config: { campaignId: b.campaignId } }), DRAFT_IDENTITY_MISMATCH);
  assert.equal(registry.getConfigById(a.campaignId).config.sheetUrl, 'sheet-a');
  assert.equal(registry.listConfigs().some(c => c.campaignId === a.campaignId), false, 'draft-only identity is not a second saved card');
});

test('corrupt settings fail without overwriting the original file', () => {
  const path = join(root, 'campaign-configs.json');
  const good = readFileSync(path, 'utf8');
  writeFileSync(path, '{broken');
  try {
    assert.throws(() => registry.saveConfig('Do not overwrite', {}));
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally { writeFileSync(path, good); }
});
