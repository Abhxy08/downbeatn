#!/usr/bin/env bash
# Builds the web app as static files and deploys Hosting + Firestore/Storage rules.
source "$(dirname "$0")/lib.sh"
load_env
[[ -n "${SERVER_URL:-}" ]] || die "SERVER_URL is empty: run scripts/deploy-server.sh first"
[[ -n "${NEXT_PUBLIC_FIREBASE_API_KEY:-}" ]] || die "Fill in the NEXT_PUBLIC_FIREBASE_* values in .env.production"

info "Building static web app against $SERVER_URL"
rm -rf "$ROOT/web/out"
(cd "$ROOT/web" && NEXT_EXPORT=1 NEXT_PUBLIC_SERVER_URL="$SERVER_URL" NEXT_PUBLIC_ALLOW_DEV_LOGIN=false npx next build --no-lint)

info "Deploying Firebase Hosting + Firestore/Storage rules"
(cd "$ROOT" && firebase_cli deploy --project "$GCP_PROJECT" --only hosting,firestore,storage)
info "Web app live at $WEB_URL"
echo "Remember: Firebase console -> Authentication -> Settings -> Authorized domains must include ${GCP_PROJECT}.web.app"
