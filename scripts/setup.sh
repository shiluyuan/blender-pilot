#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo '.env already exists; keeping your configuration.'
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo 'Install openssl first.' >&2; exit 1; }
umask 077
pilot_password=$(openssl rand -hex 16)
pilot_token=$(openssl rand -hex 32)
cat > .env <<CONFIG
PILOT_PASSWORD=$pilot_password
PILOT_INTERNAL_TOKEN=$pilot_token
PILOT_BIND=127.0.0.1
PILOT_PORT=8090
PILOT_SECURE_COOKIE=false
PILOT_RESOLUTION=1440x900x24
CONFIG
printf 'Created .env. Your workspace password: %s\n' "$pilot_password"
printf '%s\n' 'Start: docker compose up -d --build' 'Open: http://localhost:8090 (remote server: use SSH forwarding or an HTTPS proxy)'
