// v1.7.51: LinkedIn-first Open Profile send — when LinkedIn fails, the Sales Nav
// fallback must land on the LEAD page, not a generic Sales Nav link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the fallback maps a member URN straight to the Sales Nav lead page and reopens the profile for a vanity slug', () => {
  const src = read('src/linkedin/outreach.js');
  const at = src.indexOf('const trySalesNav = async () => {');
  const fn = src.slice(at, src.indexOf('const tryLinkedIn = async () => {', at));
  assert.match(fn, /\/\^AC\[A-Za-z0-9_-\]\{10,\}\$\/\.test\(_origPublicId\)/);
  assert.match(fn, /salesNavUrl = `https:\/\/www\.linkedin\.com\/sales\/lead\/\$\{_origPublicId\}`/);
  assert.match(fn, /page\.goto\(`https:\/\/www\.linkedin\.com\/in\/\$\{_origPublicId\}`/);
  assert.match(fn, /salesNavUrl = await resolveSalesNavUrlFromInProfile\(page\)/);
  // waits for the lead page + Message button rather than a blind 5s
  assert.match(fn, /while \(Date\.now\(\) - _t0 < 15000\)/);
});

test('the profile-menu resolver only accepts a lead link, never a bare /sales/ product link', () => {
  const src = read('src/linkedin/actions.js');
  const fn = src.slice(src.indexOf('export async function resolveSalesNavUrlFromInProfile'), src.indexOf('export async function resolveSalesNavUrlFromInProfile') + 4000);
  assert.match(fn, /const isLead = \(h\) => \/\\\/sales\\\/\(\?:lead\|people\)\\\/\[A-Za-z0-9_%,-\]\{6,\}\/\.test\(h\);/);
  const isLead = (h) => /\/sales\/(?:lead|people)\/[A-Za-z0-9_%,-]{6,}/.test(h);
  assert.equal(isLead('https://www.linkedin.com/sales/lead/ACwAAAMBMF8BKakzgnvpHYe4HUQ8zshu2Llnsvk,NAME_SEARCH,abc'), true);
  assert.equal(isLead('https://www.linkedin.com/sales/people/ACwAAAMBMF8BKakzgnvpHYe4HUQ8zshu2Llnsvk'), true);
  assert.equal(isLead('https://www.linkedin.com/sales/'), false);
  assert.equal(isLead('https://www.linkedin.com/sales/people/'), false);
  assert.equal(isLead('https://business.linkedin.com/sales-solutions'), false);
});
