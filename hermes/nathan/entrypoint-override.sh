#!/bin/zsh

chown -R hermes:hermes /opt/data 2>/dev/null || true

mkdir -p /opt/data/logs
chown hermes:hermes /opt/data/logs

if [[ ! -f /opt/data/config.yaml && -n "${NEXOS_API_KEY:-}" ]]; then
  gosu hermes hermes config set model.provider nexosai
  gosu hermes hermes config set model.default "Claude Sonnet 4.6"
  gosu hermes hermes config set model.base_url "https://api.nexos.ai/v1"
fi

export HERMES_DASHBOARD=1
export HERMES_DASHBOARD_HOST="${HERMES_DASHBOARD_HOST:-0.0.0.0}"
export HERMES_DASHBOARD_PORT="${HERMES_DASHBOARD_PORT:-4864}"

if [[ -n "${ADMIN_USERNAME:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  export HERMES_DASHBOARD_BASIC_AUTH_USERNAME="$ADMIN_USERNAME"
  export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="$ADMIN_PASSWORD"
fi

exec /init /opt/hermes/docker/main-wrapper.sh gateway run
