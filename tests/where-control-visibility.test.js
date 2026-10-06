// The RUNNING ON (Cloud VM / This Mac) control vanished from a campaign that
// was plainly monitoring: engine row 2026-08-27 for cmp_13s04kukmt7b0ro6 read
// status 'stopping', monitor_state 'monitoring', next_check_at 17:36. The
// control gated on `status.state === 'monitoring'` alone, so a live monitor
// running under any other status failed every branch and the block rendered
// empty — exactly when the operator wants to move the checks between machines.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// whereBlockHtml leans on a handful of module-scope helpers; stub them to the
// neutral values they hold when no move is in flight.
const whereBlockHtml = new Function(`
  const _whBusy = null, _whAsk = null, _whMsg = null;
  const escHtml = (s) => String(s);
  const _whAgo = () => 'just now';
  function _whSide(status) { return status && status._side === 'local' ? 'local' : 'vm'; }
  ${lift('whereBlockHtml')}
  return whereBlockHtml;
`)();

test('Basics does not offer a VM switcher even for legacy monitoring records', () => {
  assert.equal(whereBlockHtml({ id: 'legacy', state: 'stopping', running: false,
    monitoring: true, _cloud: true }), '');
});

test('the switcher still hides when nothing is running or monitoring', () => {
  const html = whereBlockHtml({
    id: 'cmp_dead', state: 'done', running: false, monitoring: false, stopReason: 'operator-stopped', _cloud: true,
  });
  assert.equal(html, '');
});
