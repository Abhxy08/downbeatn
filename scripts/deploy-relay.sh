#!/usr/bin/env bash
# Deploys the UDP audio relay to a Compute Engine e2-micro VM with a static IP.
# (Cloud Run can't receive UDP, so the relay lives on a VM.)
source "$(dirname "$0")/lib.sh"
load_env
require_cmd gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
require_secret RELAY_SECRET

VM=downbeat-relay
IP_NAME=downbeat-relay-ip
PORT=48000
gcloud config set project "$GCP_PROJECT" >/dev/null

info "Enabling Compute Engine API"
gcloud services enable compute.googleapis.com

info "Reserving static IP ($IP_NAME)"
gcloud compute addresses describe "$IP_NAME" --region "$GCP_REGION" >/dev/null 2>&1 ||
  gcloud compute addresses create "$IP_NAME" --region "$GCP_REGION"
RELAY_IP=$(gcloud compute addresses describe "$IP_NAME" --region "$GCP_REGION" --format='value(address)')

info "Opening UDP $PORT"
gcloud compute firewall-rules describe allow-downbeat-relay >/dev/null 2>&1 ||
  gcloud compute firewall-rules create allow-downbeat-relay --direction INGRESS --action ALLOW \
    --rules "udp:$PORT" --target-tags downbeat-relay --source-ranges 0.0.0.0/0

if ! gcloud compute instances describe "$VM" --zone "$RELAY_ZONE" >/dev/null 2>&1; then
  info "Creating VM $VM (e2-micro, Debian 12)"
  gcloud compute instances create "$VM" --zone "$RELAY_ZONE" --machine-type e2-micro \
    --image-family debian-12 --image-project debian-cloud --tags downbeat-relay \
    --address "$RELAY_IP" \
    --metadata startup-script='#!/bin/bash
      command -v node >/dev/null || (apt-get update && apt-get install -y nodejs npm)'
  info "Waiting for the VM to boot"
  sleep 45
fi

info "Building relay"
(cd "$ROOT" && npm run build --workspace relay)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp "$ROOT"/relay/dist/*.js "$STAGE/"
cat > "$STAGE/package.json" <<'JSON'
{ "name": "downbeat-relay", "private": true, "main": "index.js", "dependencies": { "dotenv": "^16.4.7" } }
JSON
cat > "$STAGE/downbeat-relay.service" <<UNIT
[Unit]
Description=DownBeat UDP audio relay
After=network-online.target

[Service]
WorkingDirectory=/opt/downbeat-relay
EnvironmentFile=/etc/downbeat-relay.env
ExecStart=/usr/bin/node /opt/downbeat-relay/index.js
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
UNIT
umask 077
printf 'NODE_ENV=production\nRELAY_PORT=%s\nRELAY_BIND_HOST=0.0.0.0\nRELAY_SECRET=%s\n' "$PORT" "$RELAY_SECRET" > "$STAGE/relay.env"

info "Uploading relay to the VM"
gcloud compute ssh "$VM" --zone "$RELAY_ZONE" --command 'mkdir -p ~/relay-upload'
gcloud compute scp --zone "$RELAY_ZONE" "$STAGE"/* "$VM":~/relay-upload/
gcloud compute ssh "$VM" --zone "$RELAY_ZONE" --command '
  set -e
  # first boot: the startup script may still be installing node/npm (slow on e2-micro)
  for i in $(seq 1 60); do command -v npm >/dev/null && ! pgrep -x apt-get >/dev/null && break; sleep 5; done
  command -v npm >/dev/null || (sudo apt-get update && sudo apt-get install -y nodejs npm)
  sudo mkdir -p /opt/downbeat-relay
  sudo cp ~/relay-upload/*.js ~/relay-upload/package.json /opt/downbeat-relay/
  sudo install -m 600 ~/relay-upload/relay.env /etc/downbeat-relay.env
  sudo cp ~/relay-upload/downbeat-relay.service /etc/systemd/system/
  rm -rf ~/relay-upload
  cd /opt/downbeat-relay && sudo npm install --omit=dev --no-audit --no-fund
  sudo systemctl daemon-reload
  sudo systemctl enable --now downbeat-relay
  sudo systemctl restart downbeat-relay
  sleep 1 && sudo systemctl --no-pager status downbeat-relay | head -5'

set_env_value PUBLIC_RELAY_IP "$RELAY_IP"
info "Relay running at $RELAY_IP:$PORT (saved PUBLIC_RELAY_IP to .env.production)"
