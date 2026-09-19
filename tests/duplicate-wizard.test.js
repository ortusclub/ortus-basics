import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('async function _openDuplicateDraft('), app.indexOf('// Delegated open/close + Duplicate action'));
function harness(answers, responses = []) {
  const prompts = [], requests = [], opened = [], notices = [];
  const input = { value: 'Original' };
  const context = vm.createContext({
    promptModal: async options => { prompts.push(options); return answers.shift() ?? null; },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return responses.shift(); },
    showCampaignToast: text => notices.push(text),
    flushAutosaveImmediate: async () => {}, clearCloudEditMode() {}, unlockCampaignType() {}, stopViewingCloudCampaign() {},
    window: {}, localStorage: { removeItem() {}, setItem() {} },
    setActiveDraftId: id => opened.push(id), goCreateCampaign() {},
    document: { getElementById: () => input }, applyPresetConfig: config => opened.push(config), syncSidebarCampaignName() {}, syncLiveStatusVisibility() {}, renderLiveConsole() {}, _localLive: null,
  });
  vm.runInContext(source, context);
  return { context, prompts, requests, opened, notices, input };
}
const response = (status, data) => ({ status, ok: status < 400, json: async () => data });

test('duplicate prompts with II, retries an existing name, and copies configuration only after saving', async () => {
  const h = harness(['Original II', 'Original III'], [response(409, { message: 'Already exists. Choose another name.' }), response(200, { draft: { id: 'new-draft', campaignId: 'duplicate-id', name: 'Original III' } })]);
  const config = { profileIds: ['a', 'b'], sheetUrl: 'sheet', templates: { primaryIntroBody: 'Hello' } };
  await h.context._openDuplicateDraft('Original', config);
  assert.equal(h.prompts[0].defaultValue, 'Original II');
  assert.equal(h.prompts[1].label, 'Already exists. Choose another name.');
  assert.equal(h.requests[0].body.uniqueName, true);
  assert.deepEqual(h.requests[1].body.config, config);
  assert.equal(h.input.value, 'Original III');
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), ['new-draft', { ...config, campaignId: 'duplicate-id' }]);
});

test('cancel leaves the source campaign untouched', async () => {
  const h = harness([null]);
  await h.context._openDuplicateDraft('Original', {});
  assert.equal(h.requests.length, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.input.value, 'Original');
});

test('source name is rejected ignoring case and whitespace, even if unsaved', async () => {
  const h = harness(['  ORIGINAL ', null]);
  await h.context._openDuplicateDraft('Original', {});
  assert.match(h.prompts[1].label, /already exists/);
  assert.equal(h.requests.length, 0);
});

test('failed creation never replaces the source draft', async () => {
  const h = harness(['Original II'], [response(500, { error: 'Disk unavailable' })]);
  await h.context._openDuplicateDraft('Original', {});
  assert.equal(h.opened.length, 0);
  assert.equal(h.input.value, 'Original');
  assert.match(h.notices[0], /Disk unavailable/);
});

test('duplicate refuses another saved campaign name and presents an explicit error', async () => {
  const h = harness(['  SAM  ', null]);
  h.context.refreshKnownCampaignNames = async () => ['sam'];
  await h.context._openDuplicateDraft('Original', {});
  assert.match(h.prompts[1].error, /already exists.*different name/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.opened.length, 0);
});
