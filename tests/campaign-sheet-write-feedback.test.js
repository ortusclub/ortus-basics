import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('setSheetSyncReporter((entry'), source.indexOf('function pushError('));
for (const result of [{ ok: true }, { ok: false, error: 'No LinkedIn URL column found in the sheet' }]) {
  test(`campaign reports durable sheet outcome: ${result.ok}`, async () => {
    const messages = [];
    let metadata, reporter;
    const context = vm.createContext({
      campaign: {}, setSheetSyncReporter: fn => { reporter = fn; },
      queueSheetWrite: async meta => { metadata = meta; reporter(meta, result); return result; },
      getFailures: () => result.ok ? [] : [result],
      log: message => messages.push(message), appendWarningLog: async () => {}, console,
    });
    vm.runInContext(code, context);
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/campaign/edit#gid=42';
    await context.trackedSheetWrite(sheetUrl, 'https://linkedin.com/in/peter', 'Peter', { stage: 'IC Sent' }, 'LinkedIn Bio');
    await context.drainSheetWrites();
    assert.equal(metadata.sheetUrl, sheetUrl);
    assert.equal(metadata.column, 'LinkedIn Bio');
    assert.equal(context.campaign.sheetWriteFailures, result.ok ? 0 : 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], result.ok ? /Sheet result saved for Peter/ : /waiting to sync for Peter: No LinkedIn URL column/);
  });
}
