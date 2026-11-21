#!/usr/bin/env bash
# Shared helpers for the deploy scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.production"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo -e "\033[1;36m==>\033[0m $*"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy .env.production.example and fill it in."
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${GCP_PROJECT:?set GCP_PROJECT in .env.production}"
  GCP_REGION="${GCP_REGION:-us-central1}"
  RELAY_ZONE="${RELAY_ZONE:-${GCP_REGION}-a}"
  WEB_URL="https://${GCP_PROJECT}.web.app"
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed. $2"; }

require_secret() {
  local name="$1" value="${!1:-}" min="${2:-32}"
  [[ -n "$value" ]] || die "$name is empty in .env.production"
  [[ ${#value} -ge $min ]] || die "$name must be at least $min characters"
  case "$value" in *downbeat-*-secret*|*change-in-prod*) die "$name still has a default value";; esac
}

# Writes KEY=VALUE pairs (only non-empty values) into a Cloud Run env-vars YAML file.
env_yaml() {
  local out="$1"; shift
  : > "$out"
  chmod 600 "$out"
  for key in "$@"; do
    local val="${!key:-}"
    [[ -n "$val" ]] || continue
    printf '%s: "%s"\n' "$key" "${val//\"/\\\"}" >> "$out"
  done
}

# Updates (or appends) KEY="value" in .env.production
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=\"${value}\"|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

firebase_cli() { npx --yes firebase-tools@13 "$@"; }
