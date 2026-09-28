import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { accountAllowsMode, accountModes, accountLabel, canOperatorUseProfile } from '../src/gologin-accounts.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const guard = server.slice(server.indexOf('async function rejectIfForeignProfiles('), server.indexOf("app.get('/api/me'"));

for (const outage of [false, true]) {
  test(`launch guard enforces Marketing restrictions with one workspace, outage=${outage}`, async () => {
    const context = vm.createContext({
      configuredAccounts: () => [{ id: 'marketing' }],
      getProfiles: async () => { if (outage) throw new Error('offline'); },
      viewerEmail: () => 'sam@ortusclub.com', accountOfProfile: () => 'marketing',
      accountAllowsMode, accountModes, accountLabel, canOperatorUseProfile,
      POST_AMPLIFICATION_MODE: 'post_amplification',
    });
    vm.runInContext(guard, context);
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    for (const mode of ['connect_only', 'connect_and_introduce', 'open_profile_only', 'follower_growth', 'post_amplification']) {
      assert.equal(await context.rejectIfForeignProfiles({}, res, ['m1'], mode), true);
      assert.equal(res.code, 403);
      assert.match(res.body.error, /only run Introduction Campaign/);
    }
    assert.equal(await context.rejectIfForeignProfiles({}, res, ['m1'], 'introduce_back'), false);
  });
}

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const renderer = app.slice(app.indexOf('function renderProfiles('), app.indexOf('function renderSelectedPanel('));
const marketing = { id: 'm1', name: 'Marketing sender', account: 'marketing', accountLabel: 'Marketing', allowedModes: ['introduce_back'] };
const regular = { id: 'o1', name: 'Regular sender', account: 'ortus', allowedModes: null };

function picker(mode) {
  const tiles = [];
  const grid = { set innerHTML(_) { tiles.length = 0; }, appendChild(tile) { tiles.push(tile); } };
  const modeInput = { value: mode };
  const context = vm.createContext({
    document: {
      getElementById: (id) => ({ 'profiles-grid': grid, 'campaign-mode': modeInput }[id] || null),
      createElement: () => {
        const cb = { addEventListener(_, fn) { this.change = fn; } };
        return { dataset: {}, classList: { add() {}, remove() {} },
          set innerHTML(html) { this.html = html; cb.disabled = /<input[^>]*disabled/.test(html); cb.checked = /<input[^>]*checked/.test(html); },
          querySelector: (selector) => selector === 'input[type="checkbox"]' ? cb : null,
        };
      },
    },
    allProfilesData: [marketing, regular], selectedProfileIds: ['m1', 'o1'], selectedProfileNames: { m1: marketing.name, o1: regular.name },
    getPassoverStatus: () => ({}), getMyIdentifier: () => 'sam', isBreakdownMode: () => false,
    findSoOForProfile: () => null, isHiddenSection: () => false, classifyAccountState: () => ({ state: 'free' }),
    escHtml: String, sooLoadState: 'ready', getSenderNameOverride: () => '', resolveSenderFirstName: () => 'Sam',
    modeNames: () => 'Introduction Campaign', renderSelectedPanel() {}, updateCampaignSummary() {},
  });
  vm.runInContext(renderer, context);
  return { context, tiles, modeInput };
}

test('other campaigns grey and disable Marketing accounts below usable accounts', () => {
  const { context, tiles } = picker('open_profile_only');
  context.renderProfiles(context.allProfilesData);
  assert.deepEqual(tiles.map(t => t.dataset.profileId), ['o1', 'm1']);
  const tile = tiles[1];
  assert.match(tile.className, /muted/);
  assert.match(tile.html, /Introduction Campaign only/);
  const cb = tile.querySelector('input[type="checkbox"]');
  assert.equal(cb.disabled, true);
  assert.equal(cb.checked, false);
  cb.checked = true;
  cb.change();
  assert.equal(cb.checked, false);
  assert.deepEqual(Array.from(context.selectedProfileIds), ['o1']);
});

test('Introduction Campaign permits Marketing; changing mode prunes even a search-hidden selection', () => {
  const { context, tiles, modeInput } = picker('introduce_back');
  context.renderProfiles(context.allProfilesData);
  const cb = tiles[0].querySelector('input[type="checkbox"]');
  assert.equal(cb.disabled, false);
  assert.equal(cb.checked, true);
  modeInput.value = 'connect_only';
  context.renderProfiles([regular]);
  assert.deepEqual(Array.from(context.selectedProfileIds), ['o1']);
  assert.equal(context.selectedProfileNames.m1, undefined);
});
