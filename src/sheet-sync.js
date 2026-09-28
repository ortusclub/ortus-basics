import { dataPath } from './paths.js';
import { createSheetWriteOutbox } from './sheet-write-outbox.js';
import { updateSheetRowResult } from './sheets-writer.js';

let outbox;
let timer;
let report = () => {};
function queue() {
  return outbox ||= createSheetWriteOutbox({
    filePath: dataPath('pending-sheet-writes.json'),
    write: entry => updateSheetRowResult(entry.sheetUrl, entry.url, JSON.parse(entry.payload), entry.column || undefined),
    onResult: (entry, result) => report(entry, result),
  });
}
export function setSheetSyncReporter(fn) { report = fn; }
export function getPendingSheetWrites() { return queue().list(); }
export function retryPendingSheetWrites() { return queue().flush({ force: true }); }
export async function queueSheetWrite(meta) {
  const id = queue().enqueue(meta); // persist before the network request starts
  await queue().flush();
  const pending = queue().list().find(entry => entry.id === id);
  return pending ? { ok: false, error: pending.errorMessage || 'Saved locally; waiting to sync.' } : { ok: true };
}
export function startSheetSync() {
  if (timer) return;
  const retry = () => Promise.resolve().then(() => queue().flush()).catch(error => {
    console.error('[sheet-sync] Recovery failed:', error.message);
    report({ leadName: 'Saved sheet results' }, { ok: false, storageError: true, error: error.message });
  });
  timer = setInterval(retry, 30000);
  timer.unref?.();
  retry();
}
