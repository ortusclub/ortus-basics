// A blocklisted COMPANY did nothing to a scrape. Operator, 2026-09-01: "PNC"
// was on the list and its people kept landing in the sheet. /api/scrape/start
// only ever built excludeUrns (people), so companies never left this machine.
//
// Domains stay behind deliberately: a scrape result has no email address.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
const client = fs.readFileSync(fileURLToPath(new URL('../src/scraper-client.js', import.meta.url)), 'utf8');
const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

const route = server.slice(server.indexOf("app.post('/api/scrape/start'"), server.indexOf("app.post('/api/scrape/start'") + 1800);

test('the scrape route builds a company exclusion list', () => {
  assert.match(route, /excludeCompanies/, 'companies must be collected');
  assert.match(route, /\(e\.kind \|\| 'company'\) === 'company'/, 'legacy entries with no kind are companies');
});

test('blank company values can never become a match-all', () => {
  assert.match(route, /String\(e\.value \|\| ''\)\.trim\(\)/,
    'an empty entry must be filtered out, not sent as ""');
});

test('domains are still NOT sent — a scrape has no email to match', () => {
  assert.ok(!/kind === 'domain'/.test(route), 'domains must not ride along');
});

test('both lists reach the engine, on single and batch', () => {
  assert.match(route, /excludeUrns, excludeCompanies/, 'the route passes both on');
  assert.equal((client.match(/excludeCompanies: excludeCompanyList/g) || []).length, 2,
    'single AND batch payloads both carry it');
});

test('the client sanitises the list the same way it sanitises URNs', () => {
  assert.match(client, /excludeCompanyList = \(Array\.isArray\(excludeCompanies\)/);
  assert.match(client, /\.filter\(Boolean\);/);
});

test('no surface still promises that domains are excluded from scrapes', () => {
  assert.ok(!/excluded from scrapes/.test(html),
    'the old blanket claim must be gone from every hint');
  // and the honest version names what actually happens
  assert.match(html, /Scrapes additionally skip blocklisted <b>companies<\/b> and <b>people<\/b>/);
  assert.match(html, /campaign-only, because a scrape has no email address/);
});
