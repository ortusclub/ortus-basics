#!/usr/bin/env bash
# Container entrypoint: start Xvfb, then Node.
#
# Orbita (launched by the GoLogin SDK) renders to the Xvfb virtual display.
# Live viewing is per-job now — server.js captures a page screenshot on demand
# (GET /api/scrape/view/:jobId) — so there's no x11vnc/websockify/noVNC stack to
# boot anymore. We exec Node as the foreground process so SIGTERM from K8s flows
# correctly to it.
set -euo pipefail

DISPLAY_NUM="${DISPLAY:-:99}"
DISPLAY_RES="${DISPLAY_RES:-1280x900x24}"

cleanup() {
  # Forward TERM to children on pod shutdown / VPA resize.
  pkill -TERM -P $$ 2>/dev/null || true
}
trap cleanup TERM INT

echo "[entrypoint] starting Xvfb on $DISPLAY_NUM ($DISPLAY_RES)"
# +extension RANDR is required for Chromium/Orbita window resize / position
# requests. Without it, some operations (newPage, viewport resize) can fail
# with cryptic "Failed to open a new tab" errors.
Xvfb "$DISPLAY_NUM" -screen 0 "$DISPLAY_RES" \
     -nolisten tcp -ac +extension RANDR &
sleep 2

echo "[entrypoint] starting Node app on :${PORT:-3000} (ROLE=${ROLE:-all})"
# ONE image, three roles: frontend / worker run the scraper (server.js decides
# by ROLE internally); campaign-worker runs the campaign runtime instead.
if [ "${ROLE:-}" = "campaign-worker" ]; then
  exec node campaign-main.js
else
  exec node server.js
fi
