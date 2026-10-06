import { appFunction } from './helpers/app-source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkIsLost, LOST_LINK_AFTER_S } from '../public/js/live-activity.mjs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// "This Mac cannot see the campaign" needs 90s of silence, not one bad poll.
// The reason was captured onto the status object, shown in the hero and thrown
// away, so every occurrence started its diagnosis from zero.
test('the hero still needs a real quiet spell, not a blip', () => {
  assert.equal(LOST_LINK_AFTER_S, 90);
  assert.equal(linkIsLost(89), false);
  assert.equal(linkIsLost(91), true);
  assert.equal(linkIsLost(600, true), false, 'a local campaign has no VM link to lose');
});

test('legacy refresh never fabricates VM outage messages', () => {
  assert.doesNotMatch(appFunction('_refreshCloudActiveStatus'), /No answer from the VM|_pushCloudEvent/);
});

test('legacy refresh does not start a cloud outage clock', () => {
  assert.doesNotMatch(appFunction('_refreshCloudActiveStatus'), /_cloudQuietSince|fetch\(/);
});

test('legacy refresh never claims the VM recovered', () => {
  assert.doesNotMatch(appFunction('_refreshCloudActiveStatus'), /answering again|_cloudQuietSince/);
});

test('the hero offers a way to check without waiting for the poll', () => {
  assert.match(APP, /window\.retryCloudLink/);
  assert.match(APP, /Check the connection now/);
});

test('the retry block comes down when the link returns', () => {
  const i = APP.indexOf('function _applyLostLinkOverride');
  const body = APP.slice(i, i + 700);
  assert.match(body, /if \(!lost\) \{/);
  assert.match(body, /back\.dataset\.lostLinkActs/, 'or it outlives the problem');
});
