const button = document.getElementById('app-google-signin');
const status = document.getElementById('app-google-status');
const browser = document.getElementById('app-google-browser');
let timer, generation = 0;
async function post(path) {
  const response = await fetch('/api/auth/google/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Google sign-in failed. Please try again.');
  return data;
}
async function poll(current) {
  if (current !== generation) return;
  try {
    const data = await post('complete');
    if (current !== generation) return;
    if (data.ok) { window.location.assign('/'); return; }
    if (data.error) throw Error(data.error);
    timer = setTimeout(()=>poll(current),1500);
  } catch(e) {
    if (current !== generation) return;
    status.textContent = e.message; button.disabled = false; button.textContent = 'Try Google sign-in again';
  }
}
button.addEventListener('click', async () => {
  clearTimeout(timer); const current = ++generation;
  button.disabled = true; browser.hidden = true;
  status.textContent = 'Opening Google sign-in…';
  document.getElementById('auth-error')?.classList.remove('visible');
  try {
    const data = await post('start');
    const url = new URL(data.url);
    if (url.origin !== 'https://accounts.google.com') throw Error('Invalid Google sign-in address.');
    browser.href = url.href; browser.hidden = false;
    window.open(url.href,'_blank','noopener');
    status.textContent = 'Finish Google sign-in in your browser. Basics will open automatically.';
    button.textContent = 'Restart Google sign-in'; button.disabled = false;
    poll(current);
  } catch(e) { status.textContent = e.message; button.disabled = false; }
});
