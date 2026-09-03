// Single source of truth for where mutable user data lives.
//
// Default: ./data (relative to current working directory) — same as the
// existing dev/CLI behaviour. The Electron wrapper sets ORTUS_DATA_DIR to
// app.getPath('userData')/data BEFORE importing the server, so each user
// gets their own writable data dir without touching any other module.

import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.env.ORTUS_DATA_DIR
  ? resolve(process.env.ORTUS_DATA_DIR)
  : resolve(process.cwd(), 'data');

try { mkdirSync(ROOT, { recursive: true }); } catch { /* */ }

export function dataPath(...segments) {
  return resolve(ROOT, ...segments);
}

export function dataRoot() {
  return ROOT;
}
