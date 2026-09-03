#!/usr/bin/env bash
# Launch this worktree against the isolated GKE development engine.
#
# Unlike a one-shot `kubectl port-forward`, this supervisor reconnects when GKE
# replaces or preempts the API pod. It also reads both deployed image tags before
# launch, so the in-app safety banner reports what Kubernetes actually runs.
set -u

DEV_NAMESPACE="salesnav-dev"
LIVE_NAMESPACE="salesnav-scraper"
DEPLOYMENT="salesnav-scraper"
LOCAL_ENGINE_PORT="3001"
ENGINE_TOKEN="${SCRAPER_ENGINE_TOKEN:-ortus2026scraper}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_REPO="${ORTUS_DEV_ENGINE_REPO:-$PROJECT_ROOT/../ortus-salesnav-scraper-cloud}"
if [ -z "${ORTUS_DEV_ENGINE_REPO:-}" ] && [ ! -d "$ENGINE_REPO" ] && [ -d "$HOME/ortus-salesnav-scraper-cloud" ]; then
  ENGINE_REPO="$HOME/ortus-salesnav-scraper-cloud"
fi
PF_PID=""
ELECTRON_PID=""

# `gcloud auth login` expires nightly under the Workspace session policy, and a
# supervisor that cannot re-authenticate reconnects forever in silence while the
# app shows a frozen VM card (measured 2026-08-28: card stuck at 01:27, engine
# swept normally at 03:10, 05:10 and 07:10). scripts/dev-tunnel-kubeconfig.sh
# writes a kubeconfig holding a Kubernetes ServiceAccount token, which the
# cluster mints and therefore never expires. Use it when it exists; fall back to
# the human gcloud session when it does not.
DEV_KUBECONFIG="${ORTUS_DEV_KUBECONFIG:-$HOME/.kube/ortus-dev.yaml}"
if [ -f "$DEV_KUBECONFIG" ]; then
  export KUBECONFIG="$DEV_KUBECONFIG"
  TUNNEL_IDENTITY="service account (does not expire)"
else
  TUNNEL_IDENTITY="your gcloud login (expires — run scripts/dev-tunnel-kubeconfig.sh once to fix)"
fi

cleanup() {
  trap - EXIT INT TERM
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  [ -n "$ELECTRON_PID" ] && kill "$ELECTRON_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

image_tag() {
  local namespace="$1"
  local image
  image="$(kubectl -n "$namespace" get deploy/"$DEPLOYMENT" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="app")].image}')" || return 1
  printf '%s' "${image##*:}"
}

start_port_forward() {
  kubectl -n "$DEV_NAMESPACE" port-forward deploy/"$DEPLOYMENT" \
    "$LOCAL_ENGINE_PORT:3000" >/tmp/ortus-dev-engine-port-forward.log 2>&1 &
  PF_PID=$!
}

engine_ready() {
  curl -fsS --max-time 5 -H "Authorization: Bearer $ENGINE_TOKEN" \
    "http://127.0.0.1:$LOCAL_ENGINE_PORT/api/health" >/dev/null 2>&1
}

# kubectl can need several seconds to resolve credentials and attach to a pod.
# Never kill a fresh tunnel merely because it was not ready within one 2s tick.
wait_for_tunnel() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    engine_ready && return 0
    kill -0 "$PF_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

DEV_VERSION="$(image_tag "$DEV_NAMESPACE")" || {
  echo "Could not read the development engine version. Run: gcloud auth login"
  exit 1
}
LIVE_VERSION="$(image_tag "$LIVE_NAMESPACE")" || {
  echo "Could not read the live engine version. Run: gcloud auth login"
  exit 1
}

# Electron must list profiles from the SAME GoLogin workspaces as the dev engine
# — all of them, not just the primary one. Loading the app's normal .env here
# would expose production profiles the isolated engine cannot open, so nothing
# is read from it beyond DEV_GOLOGIN_API_TOKEN; the secondary workspaces come
# from the engine itself, which is configured with exactly the ones it can open.
# A tester whose campaigns run on Linked Velocity accounts cannot test anything
# against an Ortus-only roster (Sam, 2026-09-02).
DEV_GOLOGIN_API_TOKEN="${DEV_GOLOGIN_API_TOKEN:-}"
DEV_GOLOGIN_TOKEN_LV=""
DEV_GOLOGIN_TOKEN_MKT=""
if [ -z "$DEV_GOLOGIN_API_TOKEN" ] && [ -f "$PROJECT_ROOT/.env" ]; then
  DEV_GOLOGIN_API_TOKEN="$(sed -n 's/^DEV_GOLOGIN_API_TOKEN=//p' "$PROJECT_ROOT/.env" | tail -1)"
fi
if [ -z "$DEV_GOLOGIN_API_TOKEN" ] && [ -f "$ENGINE_REPO/.env" ]; then
  DEV_GOLOGIN_API_TOKEN="$(sed -n 's/^DEV_GOLOGIN_API_TOKEN=//p' "$ENGINE_REPO/.env" | tail -1)"
fi
echo "Development Electron"
echo "  app worktree: $(pwd)"
echo "  dev engine:   $DEV_VERSION"
echo "  live engine:  $LIVE_VERSION"
echo "  tunnel auth:  $TUNNEL_IDENTITY"

# ── Engine drift guard (Ortus Basics) ────────────────────────────────────────
# This capsule is a frozen snapshot, but salesnav-dev is shared infrastructure
# that anyone can redeploy. The launcher reads whatever image is deployed, so
# without this check a colleague's deploy would silently change the engine the
# capsule tests against — the one thing a time capsule must not allow.
#
# The digest is the pin, not the tag: a tag can be repointed at a new image
# while keeping its name, so comparing tags alone proves nothing.
ENGINE_PIN_FILE="$PROJECT_ROOT/.ortus-basics-engine-pin"
running_digest() {
  # imageID on a running pod is the resolved digest. Read it from the API pod
  # (the deployment the tunnel targets); workers scale to 0 via KEDA and may
  # have no pod at all, so they cannot be relied on here.
  kubectl -n "$DEV_NAMESPACE" get pods \
    -l app.kubernetes.io/name="$DEPLOYMENT" \
    -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="app")].imageID}' 2>/dev/null \
    | sed 's/.*@//'
}
if [ -f "$ENGINE_PIN_FILE" ]; then
  PINNED_TAG="$(sed -n 's/^TAG=//p' "$ENGINE_PIN_FILE" | tail -1)"
  PINNED_DIGEST="$(sed -n 's/^DIGEST=//p' "$ENGINE_PIN_FILE" | tail -1)"
  ACTUAL_DIGEST="$(running_digest)"

  if [ "${ORTUS_REPIN_ENGINE:-}" = "1" ] && [ -n "$ACTUAL_DIGEST" ]; then
    sed -i.bak "s|^TAG=.*|TAG=$DEV_VERSION|; s|^DIGEST=.*|DIGEST=$ACTUAL_DIGEST|" "$ENGINE_PIN_FILE"
    rm -f "$ENGINE_PIN_FILE.bak"
    echo "  engine pin:   RE-PINNED to $DEV_VERSION ($ACTUAL_DIGEST)"
  elif [ -z "$ACTUAL_DIGEST" ]; then
    echo "  engine pin:   ⚠ could not read the running engine digest — not verified"
  elif [ "$ACTUAL_DIGEST" != "$PINNED_DIGEST" ]; then
    echo
    echo "  ✗ DEVELOPMENT ENGINE HAS CHANGED"
    echo
    echo "    This capsule is pinned to: $PINNED_TAG"
    echo "      $PINNED_DIGEST"
    echo "    salesnav-dev now runs:     $DEV_VERSION"
    echo "      $ACTUAL_DIGEST"
    echo
    echo "    Someone redeployed the shared development engine. Anything you"
    echo "    test now runs against different engine code than this capsule"
    echo "    was built against."
    echo
    echo "    Start anyway (this once):  ORTUS_ALLOW_ENGINE_DRIFT=1 npm run electron:dev"
    echo "    Accept the new engine:     ORTUS_REPIN_ENGINE=1 npm run electron:dev"
    echo
    if [ "${ORTUS_ALLOW_ENGINE_DRIFT:-}" != "1" ]; then
      exit 1
    fi
    echo "  engine pin:   ⚠ DRIFTED — continuing because ORTUS_ALLOW_ENGINE_DRIFT=1"
  else
    echo "  engine pin:   ✓ $PINNED_TAG (digest verified)"
  fi
fi


start_port_forward

# Wait for the first tunnel before Electron starts polling the engine.
if ! wait_for_tunnel; then
  echo "Could not establish the development-engine tunnel."
  tail -20 /tmp/ortus-dev-engine-port-forward.log 2>/dev/null || true
  exit 1
fi

# A teammate cloning only the app repository does not need the GoLogin secret
# in a local file. Once their authenticated kubectl tunnel reaches dev-2+, ask
# that isolated engine for its matching development credentials. Production
# deliberately returns 404 for this endpoint.
#
# Asked for unconditionally, because the secondary workspaces are only ever
# known here: a local .env supplies the primary token alone. An engine older
# than dev-31 answers with just that one, and the rest stay blank.
BOOTSTRAP="$(curl -fsS --max-time 8 \
  -H "Authorization: Bearer $ENGINE_TOKEN" \
  "http://127.0.0.1:$LOCAL_ENGINE_PORT/api/dev/bootstrap" 2>/dev/null)"
read_bootstrap() {
  printf '%s' "$BOOTSTRAP" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(s)[process.argv[1]] || "")); } catch {}
    });' "$1"
}
if [ -n "$BOOTSTRAP" ]; then
  [ -z "$DEV_GOLOGIN_API_TOKEN" ] && DEV_GOLOGIN_API_TOKEN="$(read_bootstrap goLoginToken)"
  DEV_GOLOGIN_TOKEN_LV="$(read_bootstrap goLoginTokenLinkedVelocity)"
  DEV_GOLOGIN_TOKEN_MKT="$(read_bootstrap goLoginTokenMarketing)"
fi
if [ -z "$DEV_GOLOGIN_API_TOKEN" ]; then
  echo "The development engine did not provide its GoLogin workspace credential."
  echo "Confirm you can access salesnav-dev and that the engine is dev-2 or newer."
  exit 1
fi

# Say which rosters this launch can actually show. Without it, an account
# somebody expects to test with is simply missing from the picker and the only
# clue is an engine secret nobody can read from here.
WORKSPACES="Ortus"
[ -n "$DEV_GOLOGIN_TOKEN_LV" ] && WORKSPACES="$WORKSPACES + Linked Velocity"
[ -n "$DEV_GOLOGIN_TOKEN_MKT" ] && WORKSPACES="$WORKSPACES + Marketing"
echo "  workspaces:   $WORKSPACES"

# ── Local engine (ORTUS_LOCAL_ENGINE=1) ──────────────────────────────────────
# Run the vendored engine in ./engine instead of the shared GKE one, so this
# app owns the engine it tests against: editable here, immune to anyone
# redeploying salesnav-dev, and unable to affect production.
#
# The GKE tunnel still comes up first, because the GoLogin workspace tokens are
# only obtainable from the dev engine's /api/dev/bootstrap. It is used for
# credentials alone — campaigns run against the local engine below.
# See engine/ORIGIN.md for what this copy is and how it differs.
APP_ENGINE_URL="http://127.0.0.1:$LOCAL_ENGINE_PORT"
LOCAL_ENGINE_PID=""
if [ "${ORTUS_LOCAL_ENGINE:-}" = "1" ]; then
  LOCAL_ENGINE_DIR="$PROJECT_ROOT/engine"
  LOCAL_ENGINE_OWN_PORT="${ORTUS_LOCAL_ENGINE_PORT:-3000}"
  if [ ! -f "$LOCAL_ENGINE_DIR/server.js" ]; then
    echo "  ✗ ORTUS_LOCAL_ENGINE=1 but $LOCAL_ENGINE_DIR/server.js is missing."
    exit 1
  fi
  (
    cd "$LOCAL_ENGINE_DIR" && env \
      PORT="$LOCAL_ENGINE_OWN_PORT" \
      ENGINE_SHARED_TOKEN="$ENGINE_TOKEN" \
      APP_PASSWORD="$ENGINE_TOKEN" \
      GOLOGIN_API_TOKEN="$DEV_GOLOGIN_API_TOKEN" \
      GOLOGIN_API_TOKEN_LINKEDVELOCITY="$DEV_GOLOGIN_TOKEN_LV" \
      GOLOGIN_API_TOKEN_MARKETING="$DEV_GOLOGIN_TOKEN_MKT" \
      node server.js
  ) >/tmp/ortus-local-engine.log 2>&1 &
  LOCAL_ENGINE_PID=$!
  for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    curl -fsS --max-time 3 -H "Authorization: Bearer $ENGINE_TOKEN" \
      "http://127.0.0.1:$LOCAL_ENGINE_OWN_PORT/api/health" >/dev/null 2>&1 && break
    kill -0 "$LOCAL_ENGINE_PID" 2>/dev/null || { echo "  ✗ local engine exited — see /tmp/ortus-local-engine.log"; tail -15 /tmp/ortus-local-engine.log; exit 1; }
    sleep 1
  done
  APP_ENGINE_URL="http://127.0.0.1:$LOCAL_ENGINE_OWN_PORT"
  DEV_VERSION="local (./engine)"
  echo "  local engine: ✓ :$LOCAL_ENGINE_OWN_PORT from ./engine — log /tmp/ortus-local-engine.log"
fi
trap '[ -n "$LOCAL_ENGINE_PID" ] && kill "$LOCAL_ENGINE_PID" 2>/dev/null' EXIT

env \
  SCRAPER_ENGINE_URL="$APP_ENGINE_URL" \
  SCRAPER_ENGINE_TOKEN="$ENGINE_TOKEN" \
  SCRAPER_ENGINE_VERSION="$DEV_VERSION" \
  PRODUCTION_ENGINE_VERSION="$LIVE_VERSION" \
  GOLOGIN_API_TOKEN="$DEV_GOLOGIN_API_TOKEN" \
  GOLOGIN_API_TOKEN_LINKEDVELOCITY="$DEV_GOLOGIN_TOKEN_LV" \
  GOLOGIN_API_TOKEN_MARKETING="$DEV_GOLOGIN_TOKEN_MKT" \
  node_modules/.bin/electron ${ORTUS_ELECTRON_ARGS:-} . &
ELECTRON_PID=$!

# Keep the tunnel alive for the lifetime of Electron. A Deployment port-forward
# is tied to one pod, so any rollout/preemption requires a fresh connection.
FAILED_HEALTH_CHECKS=0
AUTH_WARNED=0
while kill -0 "$ELECTRON_PID" 2>/dev/null; do
  if kill -0 "$PF_PID" 2>/dev/null && engine_ready; then
    FAILED_HEALTH_CHECKS=0
  else
    FAILED_HEALTH_CHECKS=$((FAILED_HEALTH_CHECKS + 1))
  fi
  # Tolerate two missed checks. A busy API or brief network wobble should not
  # turn one usable tunnel into an endless kill/reconnect cycle.
  if [ "$FAILED_HEALTH_CHECKS" -ge 3 ]; then
    echo "Dev engine tunnel disconnected; reconnecting…"
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    start_port_forward
    if wait_for_tunnel; then
      FAILED_HEALTH_CHECKS=0
      AUTH_WARNED=0
      echo "Dev engine tunnel reconnected."
    elif [ "$AUTH_WARNED" -eq 0 ] \
      && grep -qiE 'reauthentication|credentials|auth login|invalid_grant' \
           /tmp/ortus-dev-engine-port-forward.log 2>/dev/null; then
      # Say the actual reason once. Without this the loop retries forever and the
      # only visible symptom is a campaign card that stopped updating hours ago.
      AUTH_WARNED=1
      echo
      echo "  The dev tunnel cannot authenticate, so the app is NOT seeing the VM."
      echo "  Everything it shows for a cloud campaign is a stale snapshot."
      echo "  Fix permanently (once):  scripts/dev-tunnel-kubeconfig.sh"
      echo "  Fix for today:           gcloud auth login"
      echo
    fi
  fi
  sleep 2
done

wait "$ELECTRON_PID" 2>/dev/null || true
