// Ortus Basics — Electron main process.
//
// Wraps the existing Express server inside Electron. No campaign/outreach
// logic is touched. The server is loaded as a module after we've set up:
//   1. ORTUS_DATA_DIR  → app.getPath('userData')/data  (per-user writable storage)
//   2. ORTUS_ELECTRON_MODE = '1'                       (server uses email-only auth)
//   3. PORT                                            (free ephemeral port)
//   4. dotenv loaded from the bundled .env             (production) or repo root (dev)
//
// Phase 11.2 (D-19..D-22): tray-first boot. No dock icon on macOS, no window on
// boot. Dashboard is a child surface opened on tray click. Close (X) hides to
// tray; only Cmd+Q or tray Quit actually terminates the process.

// MUST be the first import: populates process.env from .env BEFORE any module
// that captures env at load time (src/sheets-webapp-url.js, pulled in via
// log-writer.js below) is evaluated. See electron/load-env.js for why.
import './load-env.js';
import { app, BrowserWindow, Tray, Menu, shell, dialog, powerMonitor } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
// Same in-process singleton the server uses — flush its ops buffer on quit so
// the last buffered events aren't lost when the operator closes the app.
import { flushOpsLog } from '../src/log-writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Paths: where to find bundled .env + repo root depending on dev/packaged ──
const REPO_ROOT = app.isPackaged
  ? process.resourcesPath
  : resolve(__dirname, '..');

// Load .env from the right place. In packaged builds, .env is shipped via
// `extraResources` so it lands at process.resourcesPath/.env.
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ── Per-user data dir — server modules read this via src/paths.js ────────────
const userDataDir = join(app.getPath('userData'), 'data');
process.env.ORTUS_DATA_DIR = userDataDir;
process.env.ORTUS_ELECTRON_MODE = '1';

// ── Pick a free port before importing the server ─────────────────────────────
// v2.57.x — Try a pinned port first, fall back to a random ephemeral port if
// it's already taken. Why pinned: browser localStorage is partitioned by
// origin (http://localhost:<port>), so a different random port every launch
// wipes every piece of UI state we persist to localStorage — onboarding tour
// completion flag, campaign drafts, identifier overrides, post-launch tip
// silencing. Pinning the port keeps the origin stable across launches so
// "remember me" UI state actually sticks. The random-port fallback preserves
// the original safety: if something else on the user's machine is using
// 7847, we degrade gracefully instead of failing to launch.
const PINNED_PORT = 7847; // "ORTU" mnemonic; arbitrary unprivileged free port

function _tryPort(port) {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(port, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

async function pickFreePort() {
  try {
    return await _tryPort(PINNED_PORT);
  } catch (err) {
    console.warn(`[main] Pinned port ${PINNED_PORT} unavailable (${err.code || err.message}); falling back to random port. UI localStorage state may not persist this session.`);
    return _tryPort(0);
  }
}

let mainWindow = null;
let serverPort = null;
let tray = null;
let serverProcess = null;
let shuttingDown = false;

async function startServer() {
  if (!serverPort) serverPort = await pickFreePort();

  // Resolve the bundled server.js. In dev, ../server.js. In packaged builds,
  // electron-builder includes the source under app.asar so the same relative
  // path works.
  const serverEntry = resolve(__dirname, '..', 'server.js');
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(serverPort), ELECTRON_RUN_AS_NODE: '1', ORTUS_ELECTRON_MODE: '1', ORTUS_DATA_DIR: userDataDir },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  serverProcess.once('exit', (code, signal) => {
    serverProcess = null;
    if (shuttingDown) return;
    // 76 = the backend asked for the whole app to quit so the update helper can
    // swap the bundle and relaunch (see /api/update-install in server.js).
    if (code === 76) {
      console.log('[main] Backend requested quit for update — quitting.');
      app.isQuitting = true;
      app.quit();
      return;
    }
    const delay = code === 75 ? 400 : 1500;
    console.warn(`[main] Campaign backend exited (code=${code}, signal=${signal || 'none'}); restarting in ${delay}ms.`);
    setTimeout(() => startServer().catch((err) => console.error('[main] backend restart failed:', err.message)), delay);
  });

  // Wait for the server to actually be listening (the import returns
  // immediately; app.listen is async). Poll /api/health up to ~10s.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start within 10 seconds');
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 11.2 — tray-first boot. NO dock icon on macOS. NO auto-window.
// Dashboard is a child surface opened on demand via tray click / menu item.
// ──────────────────────────────────────────────────────────────────────────

function trayIconPath() {
  // macOS auto-inverts files whose name ends in Template.png. On non-darwin
  // platforms the Template suffix is ignored and the PNG renders as-is.
  return resolve(__dirname, '..', 'build', 'tray-iconTemplate.png');
}

function getOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    // Derived, not written: a literal here drifted from the released version.
    title: `Ortus Basics — Version ${app.getVersion()}`,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  return mainWindow;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => getOrCreateWindow() },
    {
      label: 'Start Campaign…',
      click: () => {
        const w = getOrCreateWindow();
        w.webContents.once('did-finish-load', () => {
          w.webContents.executeJavaScript(
            "document.getElementById('nav-pace')?.scrollIntoView({ behavior: 'smooth' })"
          ).catch(() => {});
        });
      },
    },
    {
      label: 'Show Browsers',
      click: () => {
        // Best-effort; the dashboard alerts on error. The main-process fetch
        // runs without a session cookie, but POST /api/browsers/show is the
        // dashboard-internal path (session check is enforced at the server).
        if (!serverPort) return;
        fetch(`http://127.0.0.1:${serverPort}/api/browsers/show`, { method: 'POST' })
          .catch(() => {});
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Ortus Basics',
      accelerator: 'CmdOrCtrl+Q',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);
}

// ── Single-instance lock — second launch opens the dashboard instead of
// spawning a separate process. ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    getOrCreateWindow();
  });

  app.whenReady().then(async () => {
    try {
      await startServer();

      // Launch the dashboard window immediately — normal desktop-app behavior.
      getOrCreateWindow();

      // Tray icon is kept as a convenience (Show Browsers, quick campaign jump).
      // Dock icon remains visible; closing the window quits the app normally.
      tray = new Tray(trayIconPath());
      tray.setToolTip(`Ortus Basics — Version ${app.getVersion()}`);
      tray.setContextMenu(buildTrayMenu());

      // v2.14.x: macOS sleep-resume hook. When the lid opens (or the system
      // wakes from sleep), ping the server's monitoring-wake endpoint so an
      // overdue auto-check fires immediately rather than waiting up to 60s
      // for the next setInterval tick.
      powerMonitor.on('suspend', () => {
        if (!serverPort) return;
        fetch(`http://127.0.0.1:${serverPort}/api/runtime/interruption`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'system-sleep' }),
        }).catch((err) => console.warn('[powerMonitor.suspend] journal failed:', err.message));
      });

      powerMonitor.on('resume', () => {
        if (!serverPort) return;
        fetch(`http://127.0.0.1:${serverPort}/api/monitoring/wake`, { method: 'POST' })
          .catch((err) => console.warn('[powerMonitor.resume] ping failed:', err.message));
        // If the in-process campaign survived sleep, the wake endpoint owns its
        // normal continuation and the temporary interruption marker is stale.
        fetch(`http://127.0.0.1:${serverPort}/api/runtime/resumed`, { method: 'POST' })
          .catch((err) => console.warn('[powerMonitor.resume] clear failed:', err.message));
      });

      tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          getOrCreateWindow();
        }
      });
    } catch (err) {
      dialog.showErrorBox(
        'Ortus Basics',
        `Failed to start.\n\n${err.message}\n\nMake sure GoLogin desktop is running, then quit and reopen the app.`,
      );
      app.quit();
    }

    app.on('activate', () => {
      // Fallback for Win/Linux tray re-activation; with the dock hidden on
      // macOS this rarely fires, but tray click handles the same intent.
      if (BrowserWindow.getAllWindows().length === 0) getOrCreateWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Drain the Operations Log buffer before the app actually terminates (Cmd+Q /
// tray Quit). Timeout-guarded so a dead network can't block the quit.
let _flushedOnQuit = false;
app.on('before-quit', async (e) => {
  if (_flushedOnQuit) return;
  e.preventDefault();
  _flushedOnQuit = true;
  shuttingDown = true;
  try {
    if (serverPort) await Promise.race([
      fetch(`http://127.0.0.1:${serverPort}/api/runtime/interruption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'app-quit' }),
      }),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  } catch (_) { /* best effort during shutdown */ }
  try { await Promise.race([flushOpsLog(), new Promise((r) => setTimeout(r, 4000))]); } catch (_) { /* */ }
  if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGTERM');
  app.quit();
});
