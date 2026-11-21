#!/usr/bin/env bash
# Full deploy: relay VM -> Cloud Run backend -> Firebase Hosting + rules.
source "$(dirname "$0")/lib.sh"
"$ROOT/scripts/deploy-relay.sh"
"$ROOT/scripts/deploy-server.sh"
"$ROOT/scripts/deploy-web.sh"
load_env
info "Done. Build the plugin for this backend with:  scripts/build-plugin.sh"
