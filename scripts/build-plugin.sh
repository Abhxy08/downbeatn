#!/usr/bin/env bash
# Release build of the plugin with the deployed backend URL baked in.
source "$(dirname "$0")/lib.sh"
URL="${1:-}"
if [[ -z "$URL" && -f "$ENV_FILE" ]]; then load_env; URL="${SERVER_URL:-}"; fi
[[ -n "$URL" ]] || die "Usage: scripts/build-plugin.sh https://downbeat-server-xxxx.run.app  (or set SERVER_URL in .env.production)"
cmake -S "$ROOT/plugin" -B "$ROOT/plugin/build-release" -DCMAKE_BUILD_TYPE=Release -DDOWNBEAT_DEFAULT_SERVER_URL="$URL"
TARGETS=(DownBeat_VST3 DownBeat_Standalone)
[[ "$(uname)" == "Darwin" ]] && TARGETS+=(DownBeat_AU)
cmake --build "$ROOT/plugin/build-release" --config Release --parallel --target "${TARGETS[@]}"
info "Built with backend $URL -> plugin/build-release/DownBeat_artefacts/"
