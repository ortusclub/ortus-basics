import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const at = server.indexOf("app.post('/api/bulk-check-now'");
const route = server.slice(at, server.indexOf("app.post('/api/bulk-check/stop'", at));

test('a manual check provisions the accepted-status column when the tab has none', () => {
  const probe = route.indexOf('const hasAccepted = headers.some(');
  const sweep = route.indexOf("campaignLog(`📡 Manual bulk Connection Status check");
  assert.ok(probe > -1 && probe < sweep, 'the column probe runs before the sweep');
  assert.match(route, /\/\^\(connection accepted status\|connected status\)\$\/i/);
  assert.match(route, /if \(!hasAccepted\) \{[\s\S]*?prepareSheet\(sheetUrl, prepMode\)/);
});

test('connect-only borrows the check_status column set, CC+IC and CC+DM keep their own', () => {
  assert.match(route, /\['connect_and_introduce', 'connect_and_message'\]\.includes\(reqMode\) \? reqMode : 'check_status'/);
});

test('the wizard sends its mode with the check so the right columns are provisioned', () => {
  const fnAt = app.indexOf('async function _launchCheckRun(scope)');
  const fn = app.slice(fnAt, app.indexOf("fetch('/api/bulk-check-now'", fnAt));
  assert.match(fn, /mode: document\.getElementById\('campaign-mode'\)\?\.value \|\| '',/);
});
