const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identityMatches, slugFromUrl } = require('./primary-session.js');

test('slug is case-insensitive, ignores trailing slash/query', () => {
  assert.equal(slugFromUrl('https://www.linkedin.com/in/Antonio-Varlese/'), 'antonio-varlese');
  assert.equal(slugFromUrl('https://www.linkedin.com/in/antonio-varlese?x=1'), 'antonio-varlese');
  assert.equal(slugFromUrl('https://www.linkedin.com/feed/'), '');
  assert.equal(identityMatches('https://www.linkedin.com/in/Antonio-Varlese/', 'antonio-varlese'), true);
  assert.equal(identityMatches('https://www.linkedin.com/in/someone-else', 'antonio-varlese'), false);
  assert.equal(identityMatches('', 'antonio-varlese'), false);
});
