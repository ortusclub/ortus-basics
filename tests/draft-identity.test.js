// A campaign's settings must only ever land on that campaign's record.
//
// The wizard is one shared form and the draft it autosaved to was an ambient
// pointer that survived opening a different campaign — so a keystroke in one
// campaign rewrote another's saved settings, name included (operator,
// 2026-09-04). These tests pin the store's half of the fix: a write that names
// one campaign cannot land on a draft belonging to another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ortus-draft-identity-'));
const { addDraft, updateDraft, getDraft, DRAFT_IDENTITY_MISMATCH } = await import('../src/drafts.js');

test('a write addressed to another campaign is refused, and changes nothing', async () => {
  const d = await addDraft({ name: 'HTECHxGGL_LON_OP_CCVI', config: { templates: { primaryIntroBody: 'golf' } } });
  const res = await updateDraft(d.id, {
    name: 'CTAX_GUES_MUN_CCVI',
    config: { templates: { primaryIntroBody: 'tax' } },
    expectKey: 'ctax_gues_mun_ccvi',
  });
  assert.equal(res, DRAFT_IDENTITY_MISMATCH);
  const after = await getDraft(d.id);
  assert.equal(after.name, 'HTECHxGGL_LON_OP_CCVI', 'name must survive a refused write');
  assert.equal(after.config.templates.primaryIntroBody, 'golf', 'message must survive a refused write');
});

test('a write addressed to its own campaign is applied', async () => {
  const d = await addDraft({ name: 'HTECHxGGL_LON_OP_CCVI', config: { templates: { primaryIntroBody: 'golf' } } });
  const res = await updateDraft(d.id, {
    config: { templates: { primaryIntroBody: 'golf v2' } },
    expectKey: 'htechxggl_lon_op_ccvi',
  });
  assert.notEqual(res, DRAFT_IDENTITY_MISMATCH);
  assert.equal(res.config.templates.primaryIntroBody, 'golf v2');
});

test('identity is case- and whitespace-insensitive, as the operator sees it', async () => {
  const d = await addDraft({ name: 'HTECHxGGL_LON_OP_CCVI', config: {} });
  const res = await updateDraft(d.id, { config: { x: 1 }, expectKey: '  htechxggl_LON_op_ccvi ' });
  assert.notEqual(res, DRAFT_IDENTITY_MISMATCH);
});

test('renaming a draft is allowed — it addresses itself by its current name', async () => {
  const d = await addDraft({ name: 'Golf day', config: {} });
  const res = await updateDraft(d.id, { name: 'Golf day v2', expectKey: 'golf day' });
  assert.notEqual(res, DRAFT_IDENTITY_MISMATCH);
  assert.equal(res.name, 'Golf day v2');
});

test('an unnamed draft adopts the first name written to it', async () => {
  const d = await addDraft({ name: '', config: {} });
  const res = await updateDraft(d.id, { name: 'Brand new', expectKey: 'brand new' });
  assert.notEqual(res, DRAFT_IDENTITY_MISMATCH);
  assert.equal(res.name, 'Brand new');
});

test('a write with no expectKey still works — older clients are not locked out', async () => {
  const d = await addDraft({ name: 'Legacy', config: {} });
  const res = await updateDraft(d.id, { config: { y: 2 } });
  assert.notEqual(res, DRAFT_IDENTITY_MISMATCH);
});

test('renaming a campaign renames its draft too — the dashboard lists drafts by name', async () => {
  const { addDraft, renameDrafts, getDraft } = await import('../src/drafts.js');
  const d = await addDraft({ name: 'HTECHxGGL_LON_OP_CCVI', config: {} });
  const n = await renameDrafts('htechxggl_lon_op_ccvi', 'HTECHxGGL_LON_OP_CCVItest');
  assert.equal(n, 1);
  assert.equal((await getDraft(d.id)).name, 'HTECHxGGL_LON_OP_CCVItest');
});

test('renaming touches only drafts with that name', async () => {
  const { addDraft, renameDrafts, getDraft } = await import('../src/drafts.js');
  const keep = await addDraft({ name: 'Untouched', config: {} });
  await addDraft({ name: 'Movable', config: {} });
  await renameDrafts('Movable', 'Moved');
  assert.equal((await getDraft(keep.id)).name, 'Untouched');
});
