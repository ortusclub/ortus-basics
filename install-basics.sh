#!/bin/bash
# Ortus Basics — one-line installer.
#
# Downloads the right DMG for this Mac, copies the app into /Applications,
# strips the quarantine flag (the build is unsigned, so Gatekeeper would
# otherwise refuse to open it), and launches.
#
# Usage — paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/ortusclub/ortus-basics/main/install-basics.sh | bash
#
# The app ships with NO credentials. On first launch it opens Settings and asks
# for a GoLogin API token; which accounts you can use follows from which tokens
# you add.

set -eo pipefail

REPO="${ORTUS_BASICS_REPO:-ortusclub/ortus-basics}"
APP_NAME="Ortus Basics.app"
APP_DEST="/Applications/$APP_NAME"

if [ "$(uname -m)" = "arm64" ]; then
  DMG="Ortus-Basics-arm64.dmg"
else
  DMG="Ortus-Basics-x64.dmg"
fi

URL="https://github.com/$REPO/releases/latest/download/$DMG"
TMP_DMG="$(mktemp /tmp/ortus-basics-XXXXXX.dmg)"
MOUNT="$(mktemp -d /tmp/ortus-basics-mnt-XXXXXX)"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  /bin/rm -f "$TMP_DMG"
  /bin/rmdir "$MOUNT" 2>/dev/null || true
}
trap cleanup EXIT

echo "→ Downloading Ortus Basics ($(uname -m))…"
/usr/bin/curl -fL --progress-bar "$URL" -o "$TMP_DMG"

echo "→ Mounting…"
/usr/bin/hdiutil attach "$TMP_DMG" -nobrowse -noautoopen -mountpoint "$MOUNT" >/dev/null

SRC="$MOUNT/$APP_NAME"
if [ ! -d "$SRC" ]; then
  # Named explicitly above so a helper app in the DMG can never be picked by
  # mistake; this is only a fallback for a renamed bundle.
  SRC="$(/bin/ls -d "$MOUNT/"*.app 2>/dev/null | head -1)"
fi
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "✗ No app found inside the DMG." >&2
  exit 1
fi

# Quit a running copy, or the replace below half-succeeds and the app misbehaves.
/usr/bin/pkill -f "$APP_DEST/Contents/MacOS/" 2>/dev/null || true
sleep 1

echo "→ Installing to /Applications…"
/bin/rm -rf "$APP_DEST"
/bin/cp -R "$SRC" "$APP_DEST"

# Unsigned build: without this, macOS reports it as damaged.
/usr/bin/xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

echo "→ Launching…"
/usr/bin/open "$APP_DEST"
echo "✓ Ortus Basics installed. Add your GoLogin token in Settings when it opens."
