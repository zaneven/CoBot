#!/usr/bin/env bash
# Optional: enable Hermes gateway's HTTP api_server so CoBot can use it as a
# scheduling/delivery/memory backend (v1.5). NOT required for P1–P4.
#
# Hermes's api_server is OFF by default and runs Hermes's OWN agent (not Claude
# Code). CoBot drives claude itself; Hermes is only used optionally.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ENV_FILE="$HERMES_HOME/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Creating $ENV_FILE"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

if ! grep -q '^API_SERVER_ENABLED=' "$ENV_FILE"; then
  echo "API_SERVER_ENABLED=1" >> "$ENV_FILE"
  echo "Added API_SERVER_ENABLED=1"
else
  echo "API_SERVER_ENABLED already set"
fi

if ! grep -q '^API_SERVER_KEY=' "$ENV_FILE"; then
  KEY=$(openssl rand -hex 24)
  echo "API_SERVER_KEY=$KEY" >> "$ENV_FILE"
  echo "Generated API_SERVER_KEY (>=16 chars). Save it for HERMES_API_KEY in CoBot's .env."
else
  echo "API_SERVER_KEY already set"
fi

# Optional explicit port (default 8642).
# grep -q '^API_SERVER_PORT=' "$ENV_FILE" || echo "API_SERVER_PORT=8642" >> "$ENV_FILE"

echo
echo "Restart the Hermes gateway to apply:"
echo "  launchctl kickstart -k gui/\$(id -u)/ai.hermes.gateway"
echo "  # or: hermes gateway run --replace"
echo
echo "Verify: curl -s -H \"Authorization: Bearer \$KEY\" http://127.0.0.1:8642/v1/capabilities"
echo "Then set HERMES_API_URL + HERMES_API_KEY in CoBot/.env and hermes.enabled=true in config.yaml."
