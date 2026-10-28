import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _formatLocalDate as introDate } from '../src/linkedin/auto-intro.js';
import { _formatLocalDate as dmDate } from '../src/linkedin/auto-dm.js';

// The follow-up writers stamp this into the sheet's "last action" column. It once contained the source text of the
// ordinal helper (`${day}${ord}` without the call), so pin the real format: "Oct 1st, 09:05".
for (const [name, fmt] of [['auto-intro', introDate], ['auto-dm', dmDate]]) {
  test(`${name} date stamp uses real ordinals`, () => {
    const at = (day) => fmt(new Date(2026, 9, day, 9, 5));
    assert.equal(at(1), 'Oct 1st, 09:05');
    assert.equal(at(2), 'Oct 2nd, 09:05');
    assert.equal(at(3), 'Oct 3rd, 09:05');
    assert.equal(at(4), 'Oct 4th, 09:05');
    assert.equal(at(11), 'Oct 11th, 09:05');
    assert.equal(at(12), 'Oct 12th, 09:05');
    assert.equal(at(13), 'Oct 13th, 09:05');
    assert.equal(at(21), 'Oct 21st, 09:05');
    assert.equal(at(22), 'Oct 22nd, 09:05');
    assert.equal(at(27), 'Oct 27th, 09:05');
  });
}
