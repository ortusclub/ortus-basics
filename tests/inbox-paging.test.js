// Manual reply check: both inboxes must page back past the watermark instead of
// stopping at the newest 20 threads. A busy account can have several pages of
// newer sends sitting on top of the campaign being checked (seen live 2026-09-29:
// the Sep 16 OPI threads started on Sales Nav page 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInboxConversations, loadSalesNavConversations, _setDeps } from '../src/linkedin/inbox-sweep.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 29);

// 20 threads per page, each page a day older than the last.
function pageOf(n, prefix) {
  return Array.from({ length: 20 }, (_, i) => ({
    threadId: `${prefix}-${n}-${i}`,
    lastActivityAt: NOW - n * DAY - i * 1000,
  }));
}

// A bare page object: no goto/waitForFunction, so the loaders skip navigation.
const page = {};

test('Sales Nav: pages back with pageStartsAt until past the watermark', async () => {
  const calls = [];
  _setDeps({
    async getSalesNavThreadsPage(_p, opts = {}) {
      const n = opts.pageStartsAt ? Number(opts.pageStartsAt) : 0;
      calls.push(n);
      return { elements: pageOf(n, 'sn'), nextPageStartsAt: String(n + 1) };
    },
  });
  try {
    const { convs, error } = await loadSalesNavConversations(page, { watermark: NOW - 6.5 * DAY });
    assert.equal(error, '');
    assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);   // page 7 is the first fully past the watermark
    assert.equal(convs.length, 7 * 20);                   // pages 0-6 are inside the window
  } finally { _setDeps(null); }
});

test('Sales Nav: stops when a page has no next marker', async () => {
  let n = 0;
  _setDeps({
    async getSalesNavThreadsPage() { n++; return { elements: pageOf(0, 'sn'), nextPageStartsAt: null }; },
  });
  try {
    const { convs } = await loadSalesNavConversations(page, { watermark: 0 });
    assert.equal(n, 1);
    assert.equal(convs.length, 20);
  } finally { _setDeps(null); }
});

test('Regular inbox: pages back with the cursor and de-duplicates page 1', async () => {
  const cursors = [];
  _setDeps({
    async getConversationsPage() { return { elements: pageOf(0, 'dm') }; },
    async getInboxCategoryPage(_p, { cursor }) {
      cursors.push(cursor);
      const n = cursor ? Number(cursor) : 0;
      return { elements: pageOf(n, 'dm'), nextCursor: String(n + 1) };
    },
  });
  try {
    const { convs, error } = await loadInboxConversations(page, { watermark: NOW - 2.5 * DAY });
    assert.equal(error, '');
    assert.deepEqual(cursors, [null, '1', '2', '3']);
    assert.equal(convs.length, 3 * 20);                   // page 0 (seen twice) + pages 1-2
  } finally { _setDeps(null); }
});

test('Regular inbox: no paging when page 1 already reaches the watermark', async () => {
  let paged = false;
  _setDeps({
    async getConversationsPage() { return { elements: pageOf(0, 'dm') }; },
    async getInboxCategoryPage() { paged = true; return null; },
  });
  try {
    // Page 1 spans NOW … NOW-19s, so a watermark 10s back is already reached.
    const { convs } = await loadInboxConversations(page, { watermark: NOW - 10 * 1000 });
    assert.equal(paged, false);
    assert.equal(convs.length, 10);
  } finally { _setDeps(null); }
});

test('Regular inbox: falls back to page 1 when the category query is unavailable', async () => {
  _setDeps({
    async getConversationsPage() { return { elements: pageOf(0, 'dm') }; },
    async getInboxCategoryPage() { return null; },
  });
  try {
    const { convs, error, complete } = await loadInboxConversations(page, { watermark: NOW - 30 * DAY });
    assert.equal(error, '');
    assert.equal(convs.length, 20);
    assert.equal(complete, false);
  } finally { _setDeps(null); }
});
