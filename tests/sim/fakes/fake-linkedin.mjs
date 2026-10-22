// A tiny stand-in for LinkedIn, served through puppeteer request interception.
// Pages are deliberately minimal: just enough DOM (h1, degree badge, aria-labelled
// buttons, an invite dialog, the Voyager invitation endpoint) for the REAL action
// code to run unmodified. Per-lead behaviour is scripted via sim.leadScript[slug].
//
//   state: 'connectable' (default) | 'pending' | 'connected' | 'not_found'
//   throttle: true    → the invitation endpoint answers HTTP 429
//   voyagerFail: true → the invitation endpoint answers HTTP 400
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function nameFromSlug(slug) {
  return slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Test Person';
}

export function profileHtml(slug, script = {}) {
  const name = script.name || nameFromSlug(slug);
  const state = script.state || 'connectable';
  const degree = state === 'connected' ? '1st' : '2nd';
  const actions = state === 'connected'
    ? `<button aria-label="Message ${esc(name)}">Message</button>`
    : state === 'pending'
      ? `<button aria-label="Pending, click to withdraw invitation sent to ${esc(name)}">Pending</button>`
      : `<button id="connect" aria-label="Invite ${esc(name)} to connect">Connect</button>
         <button aria-label="Follow ${esc(name)}">Follow</button>`;
  return `<!doctype html><html><head><title>${esc(name)} | LinkedIn</title></head><body>
  <nav><a aria-label="My Network" href="/mynetwork/">My Network</a><a aria-label="Messaging" href="/messaging/">Messaging</a></nav>
  <main><section class="artdeco-card pv-top-card">
    <h1 class="text-heading-xlarge">${esc(name)}</h1>
    <p style="display:inline-block">· ${degree}</p>
    <p>Head of Sales at Example Co</p>
    <div class="actions">${actions}</div>
  </section></main>
  <div id="dlg" role="dialog" style="display:none">
    <p>Add a note to ${esc(name)}'s invitation?</p>
    <button aria-label="Add a note">Add a note</button>
    <button aria-label="Send without a note">Send without a note</button>
    <button aria-label="Dismiss">Dismiss</button>
  </div>
  <script>
    const c = document.getElementById('connect');
    const dlg = document.getElementById('dlg');
    if (c) c.addEventListener('click', () => { dlg.style.display = 'block'; });
    dlg.querySelector('[aria-label="Send without a note"]').addEventListener('click', async () => {
      dlg.style.display = 'none';
      const r = await fetch('/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResult-1', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: ${JSON.stringify(slug)} }),
      });
      if (r.ok && c) { c.outerHTML = '<button aria-label="Pending, click to withdraw invitation sent to ${esc(name)}">Pending</button>'; }
    });
  </script></body></html>`;
}


// /messaging/compose/ — covers both flows the engine uses:
//   ?recipient=<slug>  recipient-pinned 1:1 compose (Open Profile / DM)
//   (no recipient)     clean compose with a typeahead, optional group name (introductions)
export function composeHtml(recipientSlug, sim, script = {}) {
  const people = sim.people || [];
  const pinned = recipientSlug ? people.find(p => p.slug === recipientSlug) : null;
  const free = !recipientSlug || script.openProfile || script.state === 'connected';
  return `<!doctype html><html><head><title>Messaging | LinkedIn</title></head><body>
  <main>
    ${recipientSlug ? `<div class="banner">${free ? 'Free message' : 'Use 1 of 5 credits'}</div>` : ''}
    ${recipientSlug ? '' : `<input aria-label="Type a name or multiple names" placeholder="Type a name" id="rcpt" autocomplete="off">
    <div id="pills"></div>
    <ul id="results" role="listbox"></ul>
    <input aria-label="Group name (optional)" id="title" style="display:none">`}
    <div role="textbox" aria-label="Write a message…" contenteditable="true" id="body" style="min-height:40px;border:1px solid #999"></div>
    <button aria-label="Send" id="send">Send</button>
  </main>
  <script>
    document.body.classList.add('boot-complete');
    // Quill-style editor: the engine pastes text via a synthetic ClipboardEvent.
    document.getElementById('body').addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      // Quill renders one <p> per line, so textContent has NO whitespace between lines.
      document.getElementById('body').innerHTML = text.split('\\n').map(l => '<p>' + (l.replace(/&/g,'&amp;').replace(/</g,'&lt;') || '<br>') + '</p>').join('');
    });
    const PEOPLE = ${JSON.stringify(people)};
    const picked = ${JSON.stringify(pinned ? [pinned.slug] : [])};
    const rcpt = document.getElementById('rcpt'), results = document.getElementById('results');
    if (rcpt) rcpt.addEventListener('input', () => {
      const q = rcpt.value.trim().toLowerCase();
      results.innerHTML = '';
      if (!q) return;
      for (const p of PEOPLE) {
        if (picked.includes(p.slug)) continue;
        if (!p.name.toLowerCase().includes(q) && !q.split(/\\s+/).every(t => p.name.toLowerCase().includes(t))) continue;
        const li = document.createElement('li');
        li.style.cssText = 'display:block;padding:4px;width:300px';
        li.innerText = p.name + '\\n· ' + (p.degree || '2nd');
        li.addEventListener('click', () => {
          picked.push(p.slug);
          document.getElementById('pills').insertAdjacentHTML('beforeend', '<span class="pill" data-slug="' + p.slug + '">' + p.name + '</span>');
          results.innerHTML = ''; rcpt.value = '';
          if (picked.length >= 2) document.getElementById('title').style.display = 'block';
        });
        results.appendChild(li);
      }
    });
    document.getElementById('send').addEventListener('click', async () => {
      const body = document.getElementById('body').innerText.trim();
      if (!body || !picked.length) return;
      const titleEl = document.getElementById('title');
      const r = await fetch('/voyager/api/sim/messaging/send', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients: picked, title: titleEl ? titleEl.value : '', body }) });
      if (r.ok) { document.getElementById('body').innerText = ''; history.pushState({}, '', '/messaging/thread/sim-' + Date.now() + '/'); }
    });
  </script></body></html>`;
}

export async function installFakeLinkedIn(browser, account, sim) {
  const hook = async (page) => {
    try {
      await page.setRequestInterception(true);
    } catch { return; }
    page.on('request', (req) => {
      const url = req.url();
      let u; try { u = new URL(url); } catch { return req.continue(); }
      if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return req.abort('blockedbyclient');
      sim.linkedinHits.push({ account: account.id, method: req.method(), path: u.pathname });
      // No session cookie => LinkedIn sends you to the login wall instead of the page.
      if (account.loggedOut && !/^\/(login|uas|checkpoint)/.test(u.pathname) && req.resourceType() === 'document') {
        return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>LinkedIn Login</title></head><body><main><h1>Sign in</h1><form action="/login"><input name="session_key"><button>Sign in</button></form></main></body></html>' });
      }
      const m = u.pathname.match(/^\/in\/([^/]+)/);
      if (m) {
        const slug = decodeURIComponent(m[1]);
        const script = sim.leadScript[slug] || {};
        if (script.state === 'not_found') {
          // Real LinkedIn redirects a missing profile to /404/ — the app keys off that URL.
          return req.respond({ status: 302, headers: { location: 'https://www.linkedin.com/404/' } });
        }
        return req.respond({ status: 200, contentType: 'text/html', body: profileHtml(slug, script) });
      }

      // Recent-connections endpoint used by the acceptance sweep (bulk check).
      if (/^\/voyager\/api\/relationships\/(dash\/)?connections(V2)?$/.test(u.pathname)) {
        const start = Number(u.searchParams.get('start') || 0);
        const accepted = start === 0 ? (sim.accepted?.[account.id] || []) : [];
        const elements = accepted.map((slug, i) => {
          const person = (sim.people || []).find(x => x.slug === slug) || { name: slug };
          const [first, ...rest] = person.name.split(' ');
          return { createdAt: Date.now() - i * 1000, connectedMember: {
            entityUrn: 'urn:li:fsd_profile:ACoAA' + slug.replace(/\W/g, ''), publicIdentifier: slug,
            firstName: first, lastName: rest.join(' '),
            objectUrn: 'urn:li:member:' + (100000 + (sim.people || []).findIndex(x => x.slug === slug)),
          } };
        });
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements, paging: { total: elements.length } }) });
      }
      if (/^\/messaging\/compose\/?$/.test(u.pathname)) {
        const rec = u.searchParams.get('recipient');
        const script = rec ? (sim.leadScript[rec] || {}) : {};
        return req.respond({ status: 200, contentType: 'text/html', body: composeHtml(rec, sim, script) });
      }
      if (u.pathname === '/voyager/api/sim/messaging/send') {
        let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* */ }
        const leadSlug = (b.recipients || []).find(x => x !== sim.primarySlug) || (b.recipients || [])[0] || '';
        const script = sim.leadScript[leadSlug] || {};
        const fail = script.messageFail === true;
        sim.messagesSent.push({ account: account.id, slug: leadSlug, recipients: b.recipients, title: b.title, body: b.body, ok: !fail });
        return req.respond({ status: fail ? 500 : 200, contentType: 'application/json', body: JSON.stringify({ ok: !fail }) });
      }
      if (/InvitationCreationResult/.test(u.pathname + u.search)) {
        let slug = '';
        try { slug = JSON.parse(req.postData() || '{}').slug || ''; } catch { /* */ }
        const script = sim.leadScript[slug] || {};
        sim.invitesSent.push({ account: account.id, slug, status: script.throttle ? 429 : script.voyagerFail ? 400 : 200 });
        if (script.throttle) return req.respond({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'Too many requests' }) });
        if (script.voyagerFail) return req.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid' }) });
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { value: { invitationUrn: 'urn:li:fsd_invitation:sim-' + slug } } }) });
      }
      return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>LinkedIn</title></head><body><main><h1>Feed</h1></main></body></html>' });
    });
  };
  for (const p of await browser.pages()) await hook(p);
  browser.on('targetcreated', async (t) => { if (t.type() === 'page') { const p = await t.page(); if (p) await hook(p); } });
}
