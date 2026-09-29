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
const welcome = document.getElementById('google-welcome');
const welcomeStatus = document.getElementById('google-welcome-status');
const welcomeSignin = document.getElementById('google-welcome-signin');
let startupChecked = false;
let busy = false, lastError = '';
function updateWelcome(data) {
  if (!welcome) return;
  if (!startupChecked) {
    startupChecked = true;
    if (!data.connected || data.error) welcome.showModal();
  }
  if (!welcome.open) return;
  if (data.connected && !data.error && !data.pending && !lastError) { welcome.close(); return; }
  welcomeStatus.textContent = data.error || lastError || (data.pending ? 'Finish sign-in in your browser, then return here.' : '');
  welcomeSignin.textContent = data.pending ? 'Restart sign-in' : 'Sign in with Google';
}
welcomeSignin?.addEventListener('click', () => connect.click());
document.getElementById('google-welcome-later')?.addEventListener('click', () => welcome.close());
async function refresh() {
  if (busy) return;
  try {
    const data = await api('');
    updateWelcome(data);
    status.textContent = data.error || lastError || (data.pending ? 'Finish Google sign-in in your browser…' : data.connected ? `Connected as ${data.email}` : 'Optional — shared Sheets access is already available.');
    if (data.pendingWrites) status.textContent += ` · ${data.pendingWrites} results saved locally, waiting to sync.`;
    const hasError = !!(data.error || lastError);
    state.textContent = hasError ? 'Needs attention' : data.pending ? 'Signing in' : data.connected ? 'Connected' : 'Not connected';
    state.className = 'cred-state ' + (hasError ? 'is-error' : data.connected && !data.pending ? 'is-set' : 'is-unset');
    disconnect.hidden = !data.connected && !data.pending;
    connect.textContent = data.connected ? 'Change' : data.pending ? 'Restart' : 'Connect';
    connect.setAttribute('aria-label', data.connected ? 'Change Google account' : data.pending ? 'Restart Google sign-in' : 'Connect Google account');
  } catch(e) { status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
}
connect.addEventListener('click', async () => {
  lastError = ''; state.textContent = 'Signing in'; state.className = 'cred-state is-unset'; busy = true; connect.disabled = true; status.textContent = 'Opening Google sign-in…';
  if (welcomeSignin) welcomeSignin.disabled = true;
  if (welcomeStatus) welcomeStatus.textContent = 'Opening Google sign-in…';
  try {
    const data = await api('/connect','POST');
    const url = new URL(data.url);
    if (url.origin !== 'https://accounts.google.com') throw Error('Invalid sign-in address.');
    window.open(url.href, '_blank', 'noopener');
    status.textContent = 'Finish Google sign-in in your browser…';
  } catch(e) { lastError = e.message; status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
  finally { busy = false; connect.disabled = false; if (welcomeSignin) welcomeSignin.disabled = false; refresh(); }
});
disconnect.addEventListener('click', async () => {
  busy = true;
  try { await api('/disconnect','POST'); } catch(e) { status.textContent = e.message; state.textContent = 'Needs attention'; state.className = 'cred-state is-error'; }
  finally { busy = false; refresh(); }
});
setInterval(() => { if (welcome?.open || !startupChecked || !document.getElementById('credentials-modal')?.classList.contains('hidden')) refresh(); }, 3000);
refresh();
