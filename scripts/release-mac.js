#!/usr/bin/env node
// Publish the macOS DMGs to GitHub Releases for Ortus Basics.
// Assets:
//   releases/latest/download/Ortus-Basics-arm64.dmg
//   releases/latest/download/Ortus-Basics-x64.dmg
//
// Usage: `npm run release:mac` (after a working `electron:build:mac`).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'ortusclub/ortus-basics';
const dist = resolve('dist');

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const tag = `v${pkg.version}`;

const arm = resolve(dist, 'Ortus-Basics-arm64.dmg');
const x64 = resolve(dist, 'Ortus-Basics-x64.dmg');

for (const f of [arm, x64]) {
  if (!existsSync(f)) {
    console.error(`[release-mac] missing ${f} — run npm run electron:build:mac first.`);
    process.exit(1);
  }
}

function sh(cmd) {
  console.log(`+ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const releaseExists = (() => {
  try { execSync(`gh release view ${tag} -R ${REPO}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
})();

if (releaseExists) {
  console.log(`[release-mac] release ${tag} exists — uploading assets with --clobber`);
  sh(`gh release upload ${tag} -R ${REPO} --clobber "${arm}" "${x64}"`);
} else {
  const notes = `Ortus Basics ${pkg.version}\n\nDownloads:\n- Apple Silicon: Ortus-Basics-arm64.dmg\n- Intel Mac: Ortus-Basics-x64.dmg`;
  sh(`gh release create ${tag} -R ${REPO} --title "Ortus Basics ${pkg.version}" --notes "${notes.replace(/"/g, '\\"')}" "${arm}" "${x64}"`);
}

console.log(`\n✓ Released ${tag}. Stable URLs:`);
console.log(`  https://github.com/${REPO}/releases/latest/download/Ortus-Basics-arm64.dmg`);
console.log(`  https://github.com/${REPO}/releases/latest/download/Ortus-Basics-x64.dmg`);
