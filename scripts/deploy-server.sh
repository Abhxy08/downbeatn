#!/usr/bin/env bash
# Deploys the backend to Cloud Run (WebSockets, sessions, event log, AI agents).
source "$(dirname "$0")/lib.sh"
load_env
require_cmd gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
require_secret JWT_SECRET
require_secret RELAY_SECRET
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "WARNING: GEMINI_API_KEY is empty: deploying without AI agents. Add it later with scripts/set-gemini-key.sh" >&2
else
  require_secret GEMINI_API_KEY 20
fi
[[ -n "${PUBLIC_RELAY_IP:-}" ]] || die "PUBLIC_RELAY_IP is empty: run scripts/deploy-relay.sh first"

SERVICE=downbeat-server
SA="downbeat-server@${GCP_PROJECT}.iam.gserviceaccount.com"
gcloud config set project "$GCP_PROJECT" >/dev/null

info "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com firebasestorage.googleapis.com iamcredentials.googleapis.com

info "Service account with least privilege (Firestore + Storage)"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create downbeat-server --display-name "DownBeat backend"
for role in roles/datastore.user roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
done

# New projects build with the Compute default service account, which needs the builder role
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects get-iam-policy "$GCP_PROJECT" --flatten='bindings[].members' \
  --filter="bindings.members:$BUILD_SA AND bindings.role:roles/cloudbuild.builds.builder" --format='value(bindings.role)' | grep -q . ||
  gcloud projects add-iam-policy-binding "$GCP_PROJECT" --condition=None >/dev/null \
    --member "serviceAccount:$BUILD_SA" --role roles/cloudbuild.builds.builder

NODE_ENV=production
FIREBASE_PROJECT_ID="$GCP_PROJECT"
FIREBASE_STORAGE_BUCKET="${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-${GCP_PROJECT}.firebasestorage.app}"
CORS_ORIGIN="${WEB_URL},https://${GCP_PROJECT}.firebaseapp.com"
RELAY_PORT=48000
ENV_YAML=$(mktemp)
trap 'rm -f "$ENV_YAML"' EXIT
env_yaml "$ENV_YAML" NODE_ENV JWT_SECRET RELAY_SECRET GEMINI_API_KEY GEMINI_MODEL GEMINI_FALLBACK_MODELS \
  LYRIA_REALTIME_MODEL PUBLIC_RELAY_IP RELAY_PORT WEB_URL CORS_ORIGIN FIREBASE_PROJECT_ID FIREBASE_STORAGE_BUCKET

# NOTE: sessions, presence and Beat Jam streams live in memory, so the MVP runs exactly ONE
# instance (max-instances=1) with CPU always allocated (WebSocket + Lyria streaming).
info "Deploying $SERVICE to Cloud Run ($GCP_REGION) — this builds the image with Cloud Build"
(cd "$ROOT" && gcloud run deploy "$SERVICE" --source . --region "$GCP_REGION" --quiet \
  --service-account "$SA" --allow-unauthenticated \
  --env-vars-file "$ENV_YAML" \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --memory 1Gi --cpu 1 --timeout 3600 --session-affinity --concurrency 250)

URL=$(gcloud run services describe "$SERVICE" --region "$GCP_REGION" --format 'value(status.url)')
set_env_value SERVER_URL "$URL"
info "Backend live at $URL (saved SERVER_URL to .env.production)"
curl -fsS "$URL/health" && echo
