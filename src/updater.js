/**
 * In-app updater helpers.
 *
 * The app ships as an unsigned DMG via GitHub Releases (see install-mac.sh).
 * There is no silent self-update (that needs code-signed + notarized builds).
 * Instead the app checks GitHub for the latest release and, when the operator
 * is behind, downloads the matching DMG and opens it so they can drag the new
 * build to /Applications.
 *
 * This module holds only the PURE logic (version parsing/compare, asset naming,
 * URL construction). All network / filesystem / `open` side-effects live in
 * server.js so the helpers below stay unit-testable.
 */

// Ortus Basics 1.0: this app has its own release line — ortus-outreach-installer
// is a different product and comparing against it made every build look stale.
export const UPDATE_REPO = 'ortusclub/ortus-basics';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Strip a leading "v" and surrounding whitespace from a tag/version string. */
export function parseVersion(tag) {
  if (tag == null) return '';
  return String(tag).trim().replace(/^v/i, '');
}

/**
 * Compare two semver-ish strings numerically, part by part.
 * Returns -1 if a < b, 1 if a > b, 0 if equal. Non-numeric/missing parts → 0.
 * Pre-release suffixes (e.g. "-beta") are ignored for the comparison.
 */
export function compareSemver(a, b) {
  const norm = (v) => parseVersion(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** True when `latest` is a strictly newer version than `current`. */
export function isBehind(current, latest) {
  if (!parseVersion(latest)) return false; // unknown latest → never prompt
  return compareSemver(current, latest) < 0;
}

/**
 * Map Node's process.arch to the DMG arch label used in release asset names.
 * scripts/rename-dmgs.js renames the x64 build to "intel"; arm64 stays "arm64".
 */
export function archLabel(processArch) {
  // Ortus Basics ships the Intel build as "x64" (electron-builder's own label),
  // not the "intel" the old rename script produced.
  return processArch === 'arm64' ? 'arm64' : 'x64';
}

/** Release asset filename for a given arch label, e.g. "Ortus-Basics-arm64.dmg". */
export function dmgAssetName(archLbl) {
  return `Ortus-Basics-${archLbl}.dmg`;
}

/**
 * Construct the "always latest" download URL for an arch. GitHub serves
 * releases/latest/download/<asset> as a redirect to the newest release's asset,
 * so we don't need to thread the tag through.
 */
export function latestDownloadUrl(archLbl) {
  return `https://github.com/${UPDATE_REPO}/releases/latest/download/${dmgAssetName(archLbl)}`;
}

/** Public release page URL for the latest release. */
export function latestReleaseUrl() {
  return `https://github.com/${UPDATE_REPO}/releases/latest`;
}
