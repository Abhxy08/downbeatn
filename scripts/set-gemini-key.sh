#!/usr/bin/env bash
# Puts GEMINI_API_KEY from .env.production onto the running Cloud Run service (no rebuild).
source "$(dirname "$0")/lib.sh"
load_env
require_cmd gcloud "Install the Google Cloud CLI"
require_secret GEMINI_API_KEY 20
gcloud run services update downbeat-server --region "$GCP_REGION" --update-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY" --quiet >/dev/null
info "Gemini key set on downbeat-server. Agent status:"
curl -fsS "$SERVER_URL/agents/status" 2>/dev/null || curl -fsS "$SERVER_URL/health"; echo
