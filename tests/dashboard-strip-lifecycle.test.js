import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('compact strip treats monitoring as a lifecycle on either machine', () => {
  assert.match(app, /it\.monitoring \|\| it\.monitoringPhase \|\| it\.engineStatus === 'monitoring'/);
  assert.match(app, /monitoring: s\.state === 'monitoring'/);
  assert.match(app, /monitoring\s*\?\s*'Monitoring'/);
});

test('local monitoring uses monitoring controls and blue presentation', () => {
  assert.match(app, /monitoring\s*\?\s*_dib\(V3_SVG_STOP, 'Stop monitoring'/);
  assert.match(html, /\.sn-strip\.monitoring::before[^}]+background:var\(--blue\)/);
  assert.match(html, /\.sn-strip\.monitoring \.sn-status\{color:var\(--blue\)/);
});

test('approved compact option uses quiet lifecycle gradients without boxed facts', () => {
  assert.match(html, /\.sn-strip\.sn-collapsed\.run\{[^}]+linear-gradient/);
  assert.match(html, /\.sn-strip\.sn-collapsed\.monitoring\{[^}]+linear-gradient/);
  assert.doesNotMatch(html, /\.sn-strip\.sn-collapsed \.sn-flow\{[^}]+border:/);
});

test('an explicitly opened cloud campaign cannot be overwritten by local polling', () => {
  assert.match(app, /if \(_viewingCloudId\) \{/);
  assert.match(app, /String\(window\.__cloudActiveStatus\.id \|\| ''\) === String\(_viewingCloudId\)/);
  assert.doesNotMatch(app, /_viewingCloudId && !\(status && \(status\.running \|\| status\.state === 'monitoring'\)\)/);
});

test('local runtime overlays only its matching adopted cloud campaign', () => {
  assert.match(app, /String\(_localLive\.id \|\| ''\) === String\(c\.id \|\| ''\)/);
  assert.doesNotMatch(app, /if \(String\(c\.runs_on \|\| ''\) === 'local' && _localLive\)/);
});

test('monitoring with unsent leads shows the approved restart action band', () => {
  assert.match(app, /resumeAt: c\.resumeTaskDueAt \|\| null/);
  assert.match(app, /class="stg-resume"/);
  assert.match(app, /ca\.resumeReason === 'daily'/);
  assert.match(app, /Sending starts at \$\{escHtml\(ca\.resumeClock\)\}/);
  assert.match(app, /startMonitoringSendingNow\(this\)/);
  assert.doesNotMatch(app, /Sending starts at \$\{sendResumeClock\} · or choose Start now/);
});

test('Basics explicitly chooses local sending or acceptance checking from monitoring', () => {
  const start = app.indexOf('window.openCampaignResumeDecision =');
  const body = app.slice(start, app.indexOf('\n};', start));
  assert.match(body, /current = 'local'/);
  assert.match(body, /What should resume now\?/);
  assert.match(body, /_resumeAcceptanceCheckNow\(id, current, btn\)/);
  assert.match(body, /campaignHandover\(id, 'local', null, 'sending'\)/);
  assert.doesNotMatch(body, /restartCloudCampaignUI\(/);
});

test('expanded banner cannot override the visible log with a private remembered event', () => {
  assert.doesNotMatch(app, /_stageNewestLogEvent/);
  assert.match(app, /latestBannerEvent\(status && status\.logs, \{ phase \}\)/);
});
