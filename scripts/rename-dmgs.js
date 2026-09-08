#!/usr/bin/env node
// Ortus Basics: electron-builder already outputs Ortus-Basics-x64.dmg and
// Ortus-Basics-arm64.dmg — no renames needed. This script is kept as a
// no-op so the npm script chain doesn't break.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
for (const name of ['Ortus-Basics-arm64.dmg', 'Ortus-Basics-x64.dmg']) {
  if (existsSync(resolve(dist, name))) {
    console.log(`[rename-dmgs] ✓ ${name} present`);
  } else {
    console.warn(`[rename-dmgs] ⚠ ${name} not found in dist/`);
  }
}
