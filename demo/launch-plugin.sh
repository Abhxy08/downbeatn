#!/usr/bin/env bash
# launch-plugin.sh <profile> <autopilot-script> <logfile>
export DOWNBEAT_PROFILE="$1" DOWNBEAT_AUTOPILOT="$2" DOWNBEAT_SERVER_URL="${DOWNBEAT_SERVER_URL:-http://localhost:8088}"
exec "$(dirname "$0")/../plugin/build/DownBeat_artefacts/Standalone/DownBeat" > "$3" 2>&1
