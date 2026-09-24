#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOMAIN="${1:-}"
BASIC_USER="${2:-touchline}"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER")"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash deploy/oracle/install.sh your-hostname.duckdns.org [login-name]" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "The hostname contains unsupported characters." >&2
  exit 1
fi
if [[ ! "$BASIC_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "The login name contains unsupported characters." >&2
  exit 1
fi
[[ -f "$PROJECT_ROOT/.env" ]] || {
  echo "Missing .env. Copy deploy/oracle/env.production.example to .env and add the cloud values first." >&2
  exit 1
}

if [[ "${EUID}" -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

echo "Installing Caddy from its signed official repository..."
$SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
$SUDO install -d -m 0755 /usr/share/keyrings
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
$SUDO apt-get update
$SUDO apt-get install -y caddy

read -r -s -p "Create the website password: " BASIC_PASSWORD
echo
[[ ${#BASIC_PASSWORD} -ge 12 ]] || {
  echo "Use a password with at least 12 characters." >&2
  exit 1
}
BASIC_PASSWORD_HASH="$(printf '%s' "$BASIC_PASSWORD" | caddy hash-password)"
unset BASIC_PASSWORD

set_env_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$PROJECT_ROOT/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$PROJECT_ROOT/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$PROJECT_ROOT/.env"
  fi
}
set_env_key SITE_URL "https://$DOMAIN"
set_env_key NEXT_PUBLIC_PROCESSOR_URL "https://$DOMAIN"
set_env_key PUBLIC_BASE_URL "https://$DOMAIN"
set_env_key LOCAL_DATA_DIR /srv/touchline-data

$SUDO install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 \
  /srv/touchline-data /srv/touchline-data/jobs /srv/touchline-data/uploads \
  /srv/touchline-data/outputs /srv/touchline-data/work
$SUDO install -d -o root -g "$RUN_GROUP" -m 0750 /etc/touchline

render_template() {
  sed \
    -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
    -e "s|__RUN_USER__|$RUN_USER|g" \
    -e "s|__RUN_GROUP__|$RUN_GROUP|g" \
    "$1"
}
render_template "$PROJECT_ROOT/deploy/oracle/touchline-processor.service.in" \
  | $SUDO tee /etc/systemd/system/touchline-processor.service >/dev/null
render_template "$PROJECT_ROOT/deploy/oracle/touchline-web.service.in" \
  | $SUDO tee /etc/systemd/system/touchline-web.service >/dev/null

sed \
  -e "s|__DOMAIN__|$DOMAIN|g" \
  -e "s|__BASIC_USER__|$BASIC_USER|g" \
  -e "s|__BASIC_PASSWORD_HASH__|$BASIC_PASSWORD_HASH|g" \
  "$PROJECT_ROOT/deploy/oracle/Caddyfile.in" \
  | $SUDO tee /etc/caddy/Caddyfile >/dev/null

$SUDO caddy validate --config /etc/caddy/Caddyfile

echo "Building the production website as $RUN_USER..."
if [[ "$(id -un)" == "$RUN_USER" ]]; then
  (cd "$PROJECT_ROOT" && npm run build)
else
  $SUDO -u "$RUN_USER" bash -lc "cd '$PROJECT_ROOT' && npm run build"
fi

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now touchline-processor.service touchline-web.service caddy.service
$SUDO systemctl restart touchline-processor.service touchline-web.service caddy.service

echo
echo "Deployment installed."
echo "Open: https://$DOMAIN"
echo "Login name: $BASIC_USER"
echo "Check: sudo systemctl status touchline-processor touchline-web caddy"
echo "Logs:  sudo journalctl -u touchline-processor -u touchline-web -f"
