# Vendored development engine — Ortus Basics Version 1.0

A local copy of the cloud scraper engine, so this app has an engine it fully
owns: editable here, unaffected by anyone redeploying shared infrastructure,
and unable to affect production in turn.

## Where it came from

    repo    ortusclub/ortus-salesnav-scraper-cloud
    branch  sam/checknow-during-send
    commit  86c91dc0b8f5f98245e2503e46ff575e24f79453
            2026-07-24 "Stamp date_last_action on error/skipped leads (v93)"
    copied  2026-09-03

## This is NOT verified to be dev-38

The engine repo has no tags, no version constant, and cloudbuild.yaml takes its
image tag as a hand-typed substitution (`--substitutions=_TAG=v29`). Nothing
ties a deployed image back to a commit, so which source built `dev-38` is
unknown. This copy is simply whatever the local checkout held — a feature
branch, not a release. To make it faithful, ask Antonio which commit produced
`dev-38` and reset this directory to it.

## How it differs from the GKE engine

  - in-memory queue, not Redis (USE_REDIS unset)
  - no Postgres (server.js:31 returns null without PG_URL)
  - no KEDA worker scaling — one process, not a scaling deployment
  - plain Node on macOS, not the built container image

Good enough to edit and test engine logic. Not good enough to reproduce a
queueing, scaling or container-environment bug.

## Running it

Opt-in, so the shared GKE engine stays the default:

    ORTUS_LOCAL_ENGINE=1 npm run electron:dev

The launcher then starts this engine on 127.0.0.1:3000, points the app at it,
and skips both the kubectl tunnel and the engine drift guard — with nothing
shared, there is nothing to drift.
