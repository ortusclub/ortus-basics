const status = document.getElementById('sheets-google-status');
const state = document.getElementById('sheets-google-state');
const connect = document.getElementById('sheets-google-connect');
const disconnect = document.getElementById('sheets-google-disconnect');
async function api(path, method = 'GET') {
  const response = await fetch('/api/sheets/google' + path, {method, headers:{'Content-Type':'application/json'}});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Could not connect Google Sheets.');
  return data;
}
let busy = false, lastError = '';
async function refresh() {
  if (busy) return;
  try {
    const data = await api('');
    status.textContent = data.error || lastError || (data.pending ? 'Finish Google sign-in in your browser…' : data.connected ? `Connected as ${data.email}` : 'Connect your company Google account.');
    if (data.pendingWrites) status.textContent += ` · ${data.pendingWrites} results saved locally, waiting to sync.`;
    const hasError = !!(data.error || lastError);
    state.textContent = hasError ? 'Needs attention' : data.pending ? 'Signing in' : data.connected ? 'Connected' : 'Not connected';
    state.className = 'cred-state ' + (hasError ? 'is-error' : data.connected && !data.pending ? 'is-set' : 'is-unset');
    disconnect.hidden = !data.connected && !data.pending;
    connect.textContent = data.connected ? 'Change' : data.pending ? 'Restart' : 'Connect';
    connect.setAttribute('aria-label', data.connected ? 'Change Google account' : data.pending ? 'Restart Google sign-in' : 'Connect Google Sheets');
  } catch(e) { status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
}
connect.addEventListener('click', async () => {
  lastError = ''; state.textContent = 'Signing in'; state.className = 'cred-state is-unset'; busy = true; connect.disabled = true; status.textContent = 'Opening Google sign-in…';
  try {
    const data = await api('/connect','POST');
    const url = new URL(data.url);
    if (url.origin !== 'https://accounts.google.com') throw Error('Invalid sign-in address.');
    window.open(url.href, '_blank', 'noopener');
    status.textContent = 'Finish Google sign-in in your browser…';
  } catch(e) { lastError = e.message; status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
  finally { busy = false; connect.disabled = false; }
});
disconnect.addEventListener('click', async () => {
  busy = true;
  try { await api('/disconnect','POST'); } catch(e) { status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
  finally { busy = false; refresh(); }
});
setInterval(() => { if (!document.getElementById('credentials-modal')?.classList.contains('hidden')) refresh(); }, 3000);
refresh();
