// Campaign test — dev-app button under "Check for updates" + live progress + results panel.
// Talks to /api/sim/* (src/sim-runner.js). Self-contained so app.js is untouched. The button only
// shows when the server reports `available` (tests/ is excluded from the packaged DMG).
(function () {
  'use strict';
  var POLL_MS = 2000;
  var status = null, report = null, timer = null, panelOpen = false, fetchedAt = 0, unseen = false, tick = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(path, opts) { return fetch(path, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { b._status = r.status; return b; }); }); }

  function eta(ms) {
    if (ms == null) return '';
    var s = Math.round(ms / 1000);
    if (s < 45) return 'less than a minute left';
    var m = Math.max(1, Math.round(s / 60));
    return 'about ' + m + ' min left';
  }
  var MODE_NAME = { connect_only: 'Connect Only', introduce_back: 'Introduction Campaign', connect_and_introduce: 'Connect + Introduce Back', connect_and_message: 'Connect + DM', open_profile_only: 'Message Campaign' };
  var FN_NAME = { 'happy': 'Normal run', 'two-accounts': 'Two accounts', 'daily-limit': 'Daily limit', 'throttled-account': 'Throttled account', 'logged-out-account': 'Logged-out account', 'launch-fails': 'Browser won\'t open', 'bad-leads': 'Bad leads', 'acceptance-followup': 'Acceptance + follow-up' };
  function dur(ms) { var s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
  function clock(ms) { var s = Math.floor(ms / 1000), m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
  function pretty(id) { return String(id).replace(/_/g, ' ').replace(/\//g, ' · ').replace(/-/g, ' '); }
  function ago(iso) {
    if (!iso) return '';
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }

  /* ── sidebar pill + slim progress ── */
  function renderPill() {
    var pill = $('ctest-pill'), wrap = $('ctest-progress'), fill = $('ctest-bar-fill'), txt = $('ctest-progress-text');
    if (!pill) return;
    if (!status || !status.available) { pill.classList.add('hidden'); wrap.classList.add('hidden'); return; }
    pill.classList.remove('hidden');
    var p = status.progress;
    pill.classList.toggle('is-running', status.state === 'running');
    pill.classList.toggle('is-unseen', unseen && status.state !== 'running');
    if (status.state === 'running' && p && p.preparing) {
      pill.textContent = 'Preparing test…'; wrap.classList.remove('hidden'); fill.style.width = '3%'; txt.textContent = 'Getting a test browser ready';
    } else if (status.state === 'running' && p) {
      pill.textContent = 'Testing · ' + p.done + ' of ' + p.total;
      wrap.classList.remove('hidden'); fill.style.width = Math.max(3, p.pct) + '%';
      txt.textContent = p.done + ' of ' + p.total + ' · ' + eta(p.etaMs);
    } else if (status.state === 'running') {
      pill.textContent = 'Starting test…'; wrap.classList.remove('hidden'); fill.style.width = '3%'; txt.textContent = 'Starting…';
    } else {
      wrap.classList.add('hidden');
      pill.textContent = status.state === 'error' ? 'Test failed — details' : unseen ? 'Test finished — view results' : status.hasReport ? 'Test results' : 'Test campaigns';
    }
  }

  /* ── panel ── */
  function ensurePanel() {
    var o = $('ctest-overlay');
    if (o) return o;
    o = el('div', 'ctest-overlay'); o.id = 'ctest-overlay'; o.hidden = true;
    o.addEventListener('click', function (e) { if (e.target === o) closePanel(); });
    var panel = el('div', 'ctest-panel'); panel.id = 'ctest-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Campaign test');
    o.appendChild(panel); document.body.appendChild(o);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen) closePanel(); });
    return o;
  }
  function openPanel() { ensurePanel().hidden = false; panelOpen = true; unseen = false; refresh(true); }
  function closePanel() { var o = $('ctest-overlay'); if (o) o.hidden = true; panelOpen = false; }

  function section(title) { var s = el('div', 'ctest-section'); if (title) s.appendChild(el('h3', 'ctest-h', title)); return s; }

  function checklist(p) {
    var wrap = el('div', 'ctest-checklist');
    var list = (p && p.scenarios) || [], groups = {}, order = [];
    list.forEach(function (x) { var m = x.id.split('/')[0]; if (!groups[m]) { groups[m] = []; order.push(m); } groups[m].push(x); });
    order.forEach(function (m) {
      var g = el('div', 'ctest-group'); g.appendChild(el('div', 'ctest-group-h', MODE_NAME[m] || pretty(m)));
      groups[m].forEach(function (x) {
        var r = el('div', 'ctest-item is-' + x.status);
        var mark = el('span', 'ctest-item-mark');
        if (x.status === 'running') mark.className += ' ctest-spin';
        mark.textContent = x.status === 'pass' ? '✓' : x.status === 'known' ? '✓' : x.status === 'new' ? '!' : x.status === 'running' ? '' : '·';
        r.appendChild(mark); r.appendChild(el('span', 'ctest-item-name', FN_NAME[x.id.split('/')[1]] || pretty(x.id.split('/')[1])));
        r.appendChild(el('span', 'ctest-item-state', x.status === 'running' ? 'running' : x.ms ? dur(x.ms) : 'waiting'));
        g.appendChild(r);
      });
      wrap.appendChild(g);
    });
    return wrap;
  }

  function controls() {
    var s = section(null), p = status && status.progress;
    if (status.state === 'running') {
      var title = el('h3', 'ctest-h ctest-running-h'); title.appendChild(el('span', 'ctest-dot')); title.appendChild(el('span', null, (status.mode === 'full' ? 'Full test' : 'Quick test') + ' running'));
      var clk = el('span', 'ctest-clock'); clk.id = 'ctest-clock'; clk.textContent = p ? clock(p.elapsedMs) : '0:00'; title.appendChild(clk);
      s.appendChild(title);
      var bar = el('div', 'ctest-live-bar'), fill = el('div', 'ctest-live-fill is-active'); fill.style.width = (p ? Math.max(3, p.pct) : 3) + '%'; bar.appendChild(fill); s.appendChild(bar);
      if (p && p.preparing) { s.appendChild(el('p', 'ctest-note', p.message || 'Getting a test browser ready (one time only)…')); s.appendChild(el('p', 'ctest-note', 'This computer has no Chrome-type browser, so the test is fetching a small one. It only happens the first time and needs internet. The scenarios start right after.')); }
      var row = el('div', 'ctest-live-row'); row.appendChild(el('span', null, p && p.preparing ? 'Preparing…' : p ? p.done + ' of ' + p.total + ' scenarios done' : 'Starting…')); row.appendChild(el('span', null, p && !p.preparing ? eta(p.etaMs) : '')); s.appendChild(row);
      if (p && p.done > 0) {
        var finished = (p.scenarios || []).filter(function (x) { return x.ms; });
        var avg = finished.length ? finished.reduce(function (a, x) { return a + x.ms; }, 0) / finished.length : 0;
        if (avg) s.appendChild(el('p', 'ctest-note', 'Each scenario is taking about ' + dur(avg) + ' on this computer' + (p.etaMs > 25 * 60000 ? ' — this machine is slow for the full test. The quick test covers the main paths in a fraction of the time.' : '.')));
      }
      s.appendChild(checklist(p));
      var btns = el('div', 'ctest-choices');
      var mini = el('button', 'ctest-btn'); mini.type = 'button'; mini.appendChild(el('span', 'ctest-btn-main', 'Minimize')); mini.appendChild(el('span', 'ctest-btn-sub', 'Keeps running · progress stays in the sidebar'));
      mini.onclick = closePanel; btns.appendChild(mini);
      var stop = el('button', 'ctest-btn ctest-btn-quiet'); stop.type = 'button'; stop.appendChild(el('span', 'ctest-btn-main', 'Stop test'));
      stop.onclick = function () { api('/api/sim/stop', { method: 'POST' }).then(function () { refresh(true); }); };
      btns.appendChild(stop); s.appendChild(btns);
      s.appendChild(el('p', 'ctest-note', 'It runs the real campaign code against a pretend LinkedIn and a pretend Google Sheet. Nothing is sent to anyone and none of your real data is touched. You can keep using the app while it runs.'));
      return s;
    }
    s.appendChild(el('h3', 'ctest-h', report ? 'Run again' : 'Run a test'));
    var choices = el('div', 'ctest-choices');
    [['quick', 'Quick test', 'A few minutes · normal run of every campaign type'],
     ['full', 'Full test', 'Under 10 minutes · also tries things going wrong']].forEach(function (c) {
      var b = el('button', 'ctest-btn'); b.type = 'button';
      b.appendChild(el('span', 'ctest-btn-main', c[1])); b.appendChild(el('span', 'ctest-btn-sub', c[2]));
      b.onclick = function () { b.disabled = true; api('/api/sim/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: c[0] }) }).then(function (r) { if (!r.ok) { alert(r.error || 'Could not start the test.'); } refresh(true); }); };
      choices.appendChild(b);
    });
    s.appendChild(choices);
    s.appendChild(el('p', 'ctest-note', 'Use the quick test before everyday changes and the full test before a release. Nothing is sent to anyone and none of your real data is touched.'));
    return s;
  }

  var MARK = { pass: ['Pass', 'mark-pass'], known: ['Known bug', 'mark-known'], new: ['New', 'mark-new'], na: ['—', 'mark-na'], notrun: ['·', 'mark-notrun'] };

  function results() {
    var out = document.createDocumentFragment();
    if (!report) return out;
    var c = report.counts, s = section('Latest results');
    var v = el('div', 'ctest-verdict' + (c.new ? ' is-new' : ''));
    v.appendChild(el('strong', null, c.new ? c.new + ' new finding' + (c.new > 1 ? 's' : '') : 'No new findings'));
    v.appendChild(el('span', null, c.total + ' tested'));
    v.appendChild(el('span', null, c.clean + ' clean'));
    v.appendChild(el('span', null, c.known + ' known bug' + (c.known === 1 ? '' : 's')));
    s.appendChild(v);
    s.appendChild(el('p', 'ctest-when', (report.quick ? 'Quick test' : 'Full test') + ' · ' + ago(report.finishedAt) + ' · ' + Math.round(report.elapsedMs / 60000) + ' min'));
    out.appendChild(s);

    var t = section('What was tested'), table = el('table', 'ctest-table'), thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', null, 'Function'));
    report.modes.forEach(function (m) { hr.appendChild(el('th', null, m.name)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = el('tbody');
    report.functions.forEach(function (f) {
      var tr = el('tr'); tr.appendChild(el('td', null, f.label));
      report.modes.forEach(function (m) { var k = MARK[f.cells[m.value]] || MARK.notrun; tr.appendChild(el('td', 'mark ' + k[1], k[0])); });
      tb.appendChild(tr);
    });
    table.appendChild(tb); t.appendChild(table);
    t.appendChild(el('p', 'ctest-legend', 'Pass · Known bug = failed because of a bug already listed below · New = a finding nobody has seen yet · — = does not apply to that campaign · "·" = not part of this test'));
    out.appendChild(t);

    var f = section('Why each failure failed');
    if (!report.failures.length) f.appendChild(el('p', 'ctest-note', 'Nothing failed.'));
    report.failures.forEach(function (x) {
      var d = el('details', 'ctest-fail' + (x.known ? '' : ' is-new')), sm = el('summary');
      var name = (report.modes.find(function (m) { return m.value === x.mode; }) || { name: x.mode }).name;
      sm.appendChild(el('span', null, name + ' — ' + x.function)); sm.appendChild(el('small', null, x.known ? 'Known bug' : 'New'));
      d.appendChild(sm);
      var body = el('div'); body.appendChild(el('div', null, x.what)); body.appendChild(el('div', null, 'What we saw: ' + x.why));
      d.appendChild(body); f.appendChild(d);
    });
    out.appendChild(f);

    var b = section('Bugs found');
    if (!report.bugs.length) b.appendChild(el('p', 'ctest-note', 'No known bugs were reproduced in this run.'));
    report.bugs.forEach(function (bug, i) {
      var card = el('div', 'ctest-bug'); card.appendChild(el('div', 'ctest-bug-n', 'Bug ' + (i + 1)));
      card.appendChild(el('p', null, String(bug.note).replace(/^REPORTED, NOT FIXED\.\s*/, '')));
      var seen = [];
      bug.where.forEach(function (id) { var parts = id.split('/'), t = (MODE_NAME[parts[0]] || pretty(parts[0])) + ' — ' + (FN_NAME[parts[1]] || pretty(parts[1])); if (seen.indexOf(t) < 0) seen.push(t); });
      card.appendChild(el('div', 'where', 'Seen in: ' + seen.join(' · ')));
      b.appendChild(card);
    });
    out.appendChild(b);

    if (report.fresh.length) {
      var n = section('New findings needing triage');
      report.fresh.forEach(function (x) { var d = el('div', 'ctest-error'); d.textContent = x.scenario + ' — ' + x.what + ' ' + x.why; n.appendChild(d); });
      out.appendChild(n);
    }
    return out;
  }

  function renderPanel() {
    if (!panelOpen) return;
    var panel = $('ctest-panel'); if (!panel || !status) return;
    panel.textContent = '';
    var head = el('div', 'ctest-head'), left = el('div');
    left.appendChild(el('div', 'ctest-eyebrow', 'Development tool'));
    left.appendChild(el('h2', 'ctest-title', 'Campaign test'));
    head.appendChild(left);
    var x = el('button', 'ctest-close', status.state === 'running' ? '—' : '✕'); x.type = 'button'; x.setAttribute('aria-label', status.state === 'running' ? 'Minimize (the test keeps running)' : 'Close'); x.title = status.state === 'running' ? 'Minimize — the test keeps running' : 'Close'; x.onclick = closePanel; head.appendChild(x);
    panel.appendChild(head);
    if (status.error) panel.appendChild(el('div', 'ctest-error', status.error));
    // After a run, lead with the results (they were easy to miss below the buttons); while running, lead with progress.
    if (status.state !== 'running' && report) { panel.appendChild(results()); panel.appendChild(controls()); }
    else { panel.appendChild(controls()); panel.appendChild(results()); }
  }

  /* ── polling ── */
  function refresh(withReport) {
    return api('/api/sim/status').then(function (s) {
      var was = status && status.state;
      status = s.available ? s : { available: false };
      if (was === 'running' && status.state !== 'running' && !panelOpen) unseen = true;
      fetchedAt = Date.now();
      var needReport = withReport || (was === 'running' && status.state !== 'running');
      var p = needReport && status.hasReport ? api('/api/sim/report').then(function (r) { report = r.counts ? r : report; }) : Promise.resolve();
      return p.then(function () { renderPill(); renderPanel(); schedule(); });
    }).catch(function () { /* server restarting — try again later */ schedule(); });
  }
  function startTick() {
    if (tick) return;
    tick = setInterval(function () {
      var c = $('ctest-clock');
      if (!c || !status || status.state !== 'running' || !status.progress) return;
      c.textContent = clock(status.progress.elapsedMs + (Date.now() - fetchedAt));
    }, 1000);
  }
  function schedule() {
    startTick();
    clearTimeout(timer);
    if (status && status.available && status.state === 'running') timer = setTimeout(function () { refresh(false); }, POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var pill = $('ctest-pill');
    if (pill) pill.addEventListener('click', openPanel);
    setTimeout(function () { refresh(false); }, 1000);
  });
  window.ortusCampaignTest = { open: openPanel, refresh: refresh };
})();
