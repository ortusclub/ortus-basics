import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareSemver, isBehind, archLabel, dmgAssetName,
  latestDownloadUrl, latestReleaseUrl, UPDATE_REPO,
} from '../src/updater.js';

test('parseVersion strips leading v and whitespace', () => {
  assert.equal(parseVersion('v2.72.1'), '2.72.1');
  assert.equal(parseVersion(' V2.73.0 '), '2.73.0');
  assert.equal(parseVersion('2.72.1'), '2.72.1');
  assert.equal(parseVersion(null), '');
  assert.equal(parseVersion(undefined), '');
});

test('compareSemver orders versions numerically, not lexically', () => {
  assert.equal(compareSemver('2.72.1', '2.73.0'), -1);
  assert.equal(compareSemver('2.73.0', '2.72.1'), 1);
  assert.equal(compareSemver('2.72.1', '2.72.1'), 0);
  // lexical comparison would wrongly say "2.9.0" > "2.10.0"
  assert.equal(compareSemver('2.9.0', '2.10.0'), -1);
  assert.equal(compareSemver('v2.72.0', '2.72.0'), 0);
});

test('compareSemver ignores pre-release suffix', () => {
  assert.equal(compareSemver('2.73.0-beta', '2.73.0'), 0);
});

test('isBehind only true when latest is strictly newer', () => {
  assert.equal(isBehind('2.72.1', '2.73.0'), true);
  assert.equal(isBehind('2.73.0', '2.72.1'), false);
  assert.equal(isBehind('2.72.1', '2.72.1'), false);
  // unknown/empty latest must never prompt an update
  assert.equal(isBehind('2.72.1', ''), false);
  assert.equal(isBehind('2.72.1', null), false);
});

test('archLabel maps arm64 to arm64, everything else to x64', () => {
  assert.equal(archLabel('arm64'), 'arm64');
  assert.equal(archLabel('x64'), 'x64');
  assert.equal(archLabel('ia32'), 'x64');
});

test('dmgAssetName matches the released artifact names', () => {
  assert.equal(dmgAssetName('arm64'), 'Ortus-Basics-arm64.dmg');
  assert.equal(dmgAssetName('x64'), 'Ortus-Basics-x64.dmg');
});

test('download + release URLs point at the latest release of the right repo', () => {
  assert.equal(
    latestDownloadUrl('arm64'),
    `https://github.com/${UPDATE_REPO}/releases/latest/download/Ortus-Basics-arm64.dmg`
  );
  assert.equal(latestReleaseUrl(), `https://github.com/${UPDATE_REPO}/releases/latest`);
  assert.equal(UPDATE_REPO, 'ortusclub/ortus-basics');
});
